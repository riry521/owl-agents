import { createUlid, utcNow } from "../../db/dist/index.js";
import { isRuleRole } from "@owl/shared";
import { HumanReadableError, invalidStateTransition, notFound } from "./errors.js";
import { fingerprint, ruleKeyFingerprint } from "./learning-fingerprint.js";
import { parseRuleYaml, renderRuleFile, type PromptRule, type RuleRole, type RuleStore } from "./rule-store.js";
import { curateRuleProposals, dice, NEAR_DUPLICATE, type RuleCurationResult } from "./rule-curation.js";
import { curationNoticeWrite, ruleAddedNotice } from "./curation-summary.js";
import { ownerLanguage } from "./owner-language.js";
import type { RulePairJudge } from "./rule-judge.js";
import { coApply } from "./rule-curation.js";
import type { KnowledgeNotes, NotePromotion } from "./knowledge-notes.js";
import type { RuleWriter } from "./rule-writer.js";
import type { CoreDatabase, CoreWriteLaneTransaction } from "./types.js";

export const RULE_PROPOSAL_MIN_SOURCES = 2;
export const RULE_PROPOSAL_SETTINGS_KEY = "rule_proposals";
export const RULE_PROPOSAL_EXPIRE_DAYS = 30;

export type RuleProposalStatus = "pending" | "awaiting_approval" | "applied" | "rejected" | "expired" | "merged";

export interface RuleProposalTidyResult {
  readonly merged: Array<{ id: string; merged_into: string; similarity: number }>;
  readonly expired: Array<{ id: string; text: string }>;
}
export type RuleProposalOrigin = "lesson" | "note" | "legacy_policy" | "metrics";
export type RuleProposalSourceKind = "work" | "note" | "legacy_policy" | "decision" | "metrics_snapshot";

export interface RuleProposalSource {
  readonly kind: RuleProposalSourceKind;
  readonly ref: string;
}

export interface RuleProposalCreateInput {
  readonly origin: RuleProposalOrigin;
  readonly source: RuleProposalSource;
  readonly input_fingerprint?: string;
  readonly level: "system" | "role";
  readonly role?: RuleRole;
  readonly text: string;
  readonly rationale: string;
  readonly applies_to: string;
  readonly project_id?: string | null;
  readonly note_id?: string | null;
}

export interface RuleProposalRecord {
  readonly id: string;
  readonly fingerprint: string;
  readonly origin: RuleProposalOrigin;
  readonly level: "system" | "role";
  readonly role: RuleRole | null;
  readonly text: string;
  readonly rationale: string;
  readonly applies_to: string;
  readonly note_id: string | null;
  readonly source_work_ids_json: string;
  readonly source_work_ids: readonly string[];
  readonly source_count: number;
  readonly project_id: string | null;
  readonly status: RuleProposalStatus;
  readonly decision: unknown;
  readonly attempts: number;
  readonly last_error: string | null;
  readonly applied_rule_id: string | null;
  readonly applied_path: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface RuleProposalCreateResult {
  readonly proposal_id: string;
  readonly status: RuleProposalStatus;
  readonly already_recorded: boolean;
  readonly merged_into?: string;
  readonly last_error?: string;
}

export interface RuleProposalCommandResult {
  readonly proposal_id: string;
  readonly status: "applied" | "rejected";
  readonly applied_rule_id: string | null;
  readonly applied_path: string | null;
}

export interface RuleProposalsOptions {
  readonly db: CoreDatabase;
  readonly writeLane: ReturnType<CoreDatabase["createWriteLane"]>;
  readonly ruleStore: Pick<RuleStore, "rules">;
  readonly ruleWriter: Pick<RuleWriter, "apply">;
  readonly notes: Pick<KnowledgeNotes, "recordPromotion">;
  readonly now?: () => string;
  readonly logger?: Pick<Console, "warn" | "error">;
  readonly min_sources?: number;
  /** Makes a judge per create; undefined (or a judge that cannot answer) leaves only the fingerprint check. */
  readonly judge?: () => RulePairJudge | undefined;
}

interface ProposalRow {
  readonly id: string;
  readonly fingerprint: string;
  readonly origin: RuleProposalOrigin;
  readonly level: "system" | "role";
  readonly role: RuleRole | null;
  readonly text: string;
  readonly rationale: string;
  readonly applies_to: string;
  readonly note_id: string | null;
  readonly source_work_ids_json: string;
  readonly project_id: string | null;
  readonly status: RuleProposalStatus;
  readonly decision_json: string | null;
  readonly attempts: number;
  readonly last_error: string | null;
  readonly applied_rule_id: string | null;
  readonly applied_path: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface SourceRow {
  readonly proposal_id: string;
}

interface CreateTransactionResult {
  readonly result: RuleProposalCreateResult;
  readonly notify: boolean;
  readonly updated_at: string;
}

interface PreparedCreateInput {
  readonly input: RuleProposalCreateInput;
  readonly text: string;
  readonly level: "system" | "role";
  readonly role: RuleRole | null;
  readonly textFingerprint: string;
  readonly inputFingerprint: string;
}

type CreateDecision =
  | { readonly kind: "recorded"; readonly proposal_id: string }
  | { readonly kind: "invalid"; readonly error: string }
  | { readonly kind: "applied"; readonly proposal_id: string }
  | { readonly kind: "duplicate_rule"; readonly rule_id: string }
  | { readonly kind: "conflict"; readonly rule_id: string }
  | { readonly kind: "rejected"; readonly proposal_id: string }
  | { readonly kind: "open"; readonly target: { readonly id: string; readonly status: RuleProposalStatus; readonly decision_json: string | null } }
  | { readonly kind: "simulated_open" }
  | { readonly kind: "new" };

/** Create and synchronously validate pending proposals; rule file writes belong to S4. */
export class RuleProposals {
  private readonly db: CoreDatabase;
  private readonly writeLane: ReturnType<CoreDatabase["createWriteLane"]>;
  private readonly ruleStore: Pick<RuleStore, "rules">;
  private readonly ruleWriter: Pick<RuleWriter, "apply">;
  private readonly notes: Pick<KnowledgeNotes, "recordPromotion">;
  private readonly now: () => string;
  private readonly minSources: number;
  private readonly makeJudge?: () => RulePairJudge | undefined;
  private readonly logger: Pick<Console, "warn">;
  private queue: Promise<void> = Promise.resolve();

  public constructor(options: RuleProposalsOptions) {
    this.db = options.db;
    this.writeLane = options.writeLane;
    this.ruleStore = options.ruleStore;
    this.ruleWriter = options.ruleWriter;
    this.notes = options.notes;
    this.now = options.now ?? utcNow;
    this.minSources = positiveInteger(options.min_sources, RULE_PROPOSAL_MIN_SOURCES);
    this.logger = options.logger ?? console;
    this.makeJudge = options.judge;
  }

  public create(input: RuleProposalCreateInput): Promise<RuleProposalCreateResult> {
    const operation = this.queue.then(() => this.createNow(input));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  /** Return whether create would insert a proposal, while tracking new open keys for dry-run batches. */
  public previewCreate(input: RuleProposalCreateInput, simulatedOpenKeys: Set<string>): boolean {
    const prepared = prepareCreateInput(input);
    const decision = decideCreate(prepared, this.db, this.ruleStore, simulatedOpenKeys);
    if (decision.kind === "new") simulatedOpenKeys.add(proposalKey(prepared));
    return decision.kind === "invalid" || decision.kind === "duplicate_rule" || decision.kind === "conflict" || decision.kind === "new";
  }

  public list(status?: RuleProposalStatus): RuleProposalRecord[] {
    if (status && !isProposalStatus(status)) throw new Error("invalid_rule_proposal_status");
    const rows = this.db.all<ProposalRow>(
      `SELECT * FROM rule_proposals${status ? " WHERE status = ?" : ""} ORDER BY created_at DESC, id`,
      ...(status ? [status] : []),
    );
    return rows.map((row) => {
      const sourceCount = this.db.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM (
           SELECT DISTINCT source_kind, source_ref FROM rule_proposal_sources WHERE proposal_id = ?
         )`,
        row.id,
      )?.count ?? 0;
      return {
        ...row,
        source_work_ids: parseStringArray(row.source_work_ids_json),
        source_count: sourceCount,
        decision: parseJson(row.decision_json),
      };
    });
  }

  /** Read-only: judge open proposals and the current rules; never writes rules or proposal rows. */
  public curate(judge?: RulePairJudge): Promise<RuleCurationResult> {
    const proposals = [...this.list("pending"), ...this.list("awaiting_approval")];
    return curateRuleProposals({ proposals, rules: this.ruleStore.rules, judge });
  }

  /**
   * Merge same-meaning open proposals into the older one and expire stale ones; never approves, rejects or writes rules.
   * Without a judge only identical texts merge.
   */
  public tidy(judge?: RulePairJudge): Promise<RuleProposalTidyResult> {
    const operation = this.queue.then(() => this.tidyNow(judge));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private expireDays(): number {
    const row = this.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", RULE_PROPOSAL_SETTINGS_KEY);
    // Why not throw: an unparseable setting falls back to the default so the nightly run keeps working.
    const value = parseJson(row?.value_json ?? null);
    return positiveInteger(isRecord(value) ? value.expire_days as number | undefined : undefined, RULE_PROPOSAL_EXPIRE_DAYS);
  }

  private async tidyNow(judge?: RulePairJudge): Promise<RuleProposalTidyResult> {
    if (judge) {
      // Why before the transaction: the write lane callback is synchronous and a model call must not hold it.
      const open = this.db.all<ProposalRow>("SELECT * FROM rule_proposals WHERE status IN ('pending', 'awaiting_approval') ORDER BY created_at, id");
      const pairs: Array<readonly [string, string]> = [];
      for (let i = 0; i < open.length; i += 1) {
        for (let j = i + 1; j < open.length; j += 1) {
          const [a, b] = [open[i] as ProposalRow, open[j] as ProposalRow];
          if (a.level === b.level && a.role === b.role && fingerprint(a.text) !== fingerprint(b.text) && judge.isCandidate(a.text, b.text)) pairs.push([a.text, b.text]);
        }
      }
      await judge.judge(pairs);
    }
    const now = this.now();
    const days = this.expireDays();
    const cutoff = new Date(Date.parse(now) - days * 86_400_000).toISOString();
    return this.writeLane.transact((transaction: CoreWriteLaneTransaction): RuleProposalTidyResult => {
      const open = transaction.all<ProposalRow>(
        "SELECT * FROM rule_proposals WHERE status IN ('pending', 'awaiting_approval') ORDER BY created_at, id",
      );
      const survivors: ProposalRow[] = [];
      // Why not read updated_at after merging: refreshing the target would push stale proposals past the cutoff.
      const touched = new Map(open.map((proposal) => [proposal.id, proposal.updated_at]));
      const merged: RuleProposalTidyResult["merged"] = [];
      for (const proposal of open) {
        let best: { row: ProposalRow; similarity: number } | undefined;
        for (const older of survivors) {
          if (older.level !== proposal.level || older.role !== proposal.role) continue;
          const exact = fingerprint(proposal.text) === fingerprint(older.text);
          if (!exact && judge?.get(proposal.text, older.text) !== "same") continue;
          const similarity = exact ? 1 : dice(proposal.text, older.text);
          if (similarity > (best?.similarity ?? -1)) best = { row: older, similarity };
        }
        if (!best) { survivors.push(proposal); continue; }
        transaction.run("UPDATE rule_proposal_sources SET proposal_id=? WHERE proposal_id=?", best.row.id, proposal.id);
        transaction.run(
          "UPDATE rule_proposals SET status='merged', decision_json=?, updated_at=? WHERE id=?",
          JSON.stringify({ reason: "merged_near_duplicate", decided_by: "curation", merged_into: best.row.id, similarity: best.similarity }),
          now,
          proposal.id,
        );
        if (proposal.updated_at > touched.get(best.row.id)!) touched.set(best.row.id, proposal.updated_at);
        const sourceCount = refreshDerivedSources(transaction, best.row.id, now);
        if (best.row.status === "pending" && sourceCount >= this.minSources) {
          transaction.run(
            "UPDATE rule_proposals SET status='awaiting_approval', decision_json=NULL, last_error=NULL WHERE id=?",
            best.row.id,
          );
        }
        merged.push({ id: proposal.id, merged_into: best.row.id, similarity: best.similarity });
      }
      // Merging refreshed the target's updated_at to now; put back the newest real source time so a later run still ages it.
      for (const target of new Set(merged.map((entry) => entry.merged_into))) {
        transaction.run("UPDATE rule_proposals SET updated_at=? WHERE id=?", touched.get(target)!, target);
      }
      const expired: RuleProposalTidyResult["expired"] = [];
      for (const proposal of survivors) {
        if (touched.get(proposal.id)! >= cutoff) continue;
        transaction.run(
          "UPDATE rule_proposals SET status='expired', decision_json=?, updated_at=? WHERE id=?",
          JSON.stringify({ reason: "expired", decided_by: "curation", days }),
          now,
          proposal.id,
        );
        expired.push({ id: proposal.id, text: proposal.text });
      }
      return { merged, expired };
    });
  }

  public approve(proposalId: string): Promise<RuleProposalCommandResult> {
    const operation = this.queue.then(() => this.approveNow(proposalId));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  public reject(proposalId: string): Promise<RuleProposalCommandResult> {
    const operation = this.queue.then(() => this.rejectNow(proposalId));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async approveNow(proposalId: string): Promise<RuleProposalCommandResult> {
    const proposal = this.db.get<ProposalRow>("SELECT * FROM rule_proposals WHERE id=?", proposalId);
    if (!proposal) throw notFound("rule_proposal", proposalId);
    if (proposal.status !== "awaiting_approval") {
      throw invalidStateTransition("Only rule proposals awaiting approval can be approved.", { proposal_id: proposalId, status: proposal.status });
    }

    const appliedRuleId = `owl-${proposal.id.toLowerCase()}`;
    // The id is unique to this proposal, so finding it means an earlier attempt wrote the rule but did not
    // record it; writing again would always fail with duplicate_rule_id.
    const alreadyWritten = this.ruleStore.rules.files?.find((file) => file.rules.some((rule) => rule.id === appliedRuleId));
    let written: { path: string };
    try {
      written = alreadyWritten ? { path: alreadyWritten.path } : await this.ruleWriter.apply({
        level: proposal.level,
        ...(proposal.role === null ? {} : { role: proposal.role }),
        id: appliedRuleId,
        text: proposal.text,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = isRecord(error) && typeof error.code === "string" ? error.code : null;
      const lastError = code ? `${code}: ${message}` : message;
      await this.writeLane.transact((transaction) => transaction.run(
        `UPDATE rule_proposals SET attempts=attempts+1, last_error=?, updated_at=?
          WHERE id=? AND status='awaiting_approval'`,
        lastError,
        this.now(),
        proposalId,
      ));
      const failureDetails = isRecord(error) && isRecord(error.details) ? error.details : {};
      throw new HumanReadableError({
        code: "rule_apply_failed",
        message: "The rule proposal could not be applied.",
        remediation: "Fix the rule store error and retry approval.",
        details: { proposal_id: proposalId, failures: [{ ...(code ? { code } : {}), message, ...failureDetails }] },
      });
    }

    const appliedAt = this.now();
    await this.writeLane.transact((transaction) => transaction.run(
      `UPDATE rule_proposals SET status='applied', applied_rule_id=?, applied_path=?, last_error=NULL, updated_at=?
        WHERE id=? AND status='awaiting_approval'`,
      appliedRuleId,
      written.path,
      appliedAt,
      proposalId,
    ));
    await this.recordPromotion(proposal, { date: appliedAt.slice(0, 10), proposal_id: proposalId, status: "applied", path: written.path });
    // The rule is already written; a failed notice must not turn the approval into an error.
    await this.writeLane.write(curationNoticeWrite(ruleAddedNotice(ownerLanguage(this.db)))).catch((error: unknown) => console.warn("[owl-core] Could not record curation_notice", error));
    return { proposal_id: proposalId, status: "applied", applied_rule_id: appliedRuleId, applied_path: written.path };
  }

  private async rejectNow(proposalId: string): Promise<RuleProposalCommandResult> {
    const proposal = this.db.get<ProposalRow>("SELECT * FROM rule_proposals WHERE id=?", proposalId);
    if (!proposal) throw notFound("rule_proposal", proposalId);
    if (proposal.status !== "awaiting_approval") {
      throw invalidStateTransition("Only rule proposals awaiting approval can be rejected.", { proposal_id: proposalId, status: proposal.status });
    }
    const rejectedAt = this.now();
    await this.writeLane.transact((transaction) => transaction.run(
      `UPDATE rule_proposals SET status='rejected', updated_at=? WHERE id=? AND status='awaiting_approval'`,
      rejectedAt,
      proposalId,
    ));
    await this.recordPromotion(proposal, { date: rejectedAt.slice(0, 10), proposal_id: proposalId, status: "rejected", path: null });
    return { proposal_id: proposalId, status: "rejected", applied_rule_id: null, applied_path: null };
  }

  private async recordPromotion(proposal: ProposalRow, entry: NotePromotion): Promise<void> {
    if (!proposal.note_id) return;
    try {
      await this.notes.recordPromotion(proposal.note_id, entry);
    } catch (error) {
      this.logger.warn("Could not record rule proposal promotion on its knowledge note.", {
        proposal_id: proposal.id,
        note_id: proposal.note_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Why before the transaction: the write lane callback is synchronous and a model call must not hold it. */
  private async judgeCreate(prepared: PreparedCreateInput): Promise<RulePairJudge | undefined> {
    const judge = this.makeJudge?.();
    if (!judge) return undefined;
    const { text, level, role } = prepared;
    const pairs: Array<readonly [string, string]> = [];
    for (const rule of this.ruleStore.rules.promptRules) {
      if (coApply(rule, { level, role }) && judge.isCandidate(text, rule.text)) pairs.push([text, rule.text]);
    }
    const open = this.db.all<{ text: string }>(
      "SELECT text FROM rule_proposals WHERE level=? AND role IS ? AND status IN ('pending', 'awaiting_approval')",
      level,
      role,
    );
    for (const row of open) if (fingerprint(row.text) !== prepared.textFingerprint && judge.isCandidate(text, row.text)) pairs.push([text, row.text]);
    try {
      await judge.judge(pairs);
    } catch (error) {
      this.logger.warn("Rule proposal judgment failed; only exact matches were checked.", { error: error instanceof Error ? error.message : String(error) });
    }
    return judge;
  }

  private async createNow(input: RuleProposalCreateInput): Promise<RuleProposalCreateResult> {
    const prepared = prepareCreateInput(input);
    const { text, level, role, textFingerprint, inputFingerprint } = prepared;
    const now = this.now();
    const judge = await this.judgeCreate(prepared);

    const outcome = await this.writeLane.transact((transaction: CoreWriteLaneTransaction): CreateTransactionResult => {
      const decision = decideCreate(prepared, transaction, this.ruleStore, undefined, judge);
      if (decision.kind === "recorded") {
        const existing = transaction.get<Pick<ProposalRow, "status" | "last_error">>(
          "SELECT status, last_error FROM rule_proposals WHERE id=?",
          decision.proposal_id,
        );
        if (!existing) throw new Error("rule_proposal_source_broken");
        return {
          result: {
            proposal_id: decision.proposal_id,
            status: existing.status,
            already_recorded: true,
            ...(existing.last_error ? { last_error: existing.last_error } : {}),
          },
          notify: false,
          updated_at: now,
        };
      }

      if (decision.kind === "invalid") {
        const proposalId = insertProposal(transaction, input, {
          id: createUlid(),
          now,
          fingerprint: textFingerprint,
          text,
          level,
          role,
          status: "rejected",
          lastError: decision.error,
        });
        insertSource(transaction, input, inputFingerprint, textFingerprint, proposalId, now);
        refreshDerivedSources(transaction, proposalId, now);
        return { result: { proposal_id: proposalId, status: "rejected", already_recorded: false, last_error: decision.error }, notify: false, updated_at: now };
      }

      if (decision.kind === "applied") {
        insertSource(transaction, input, inputFingerprint, textFingerprint, decision.proposal_id, now);
        refreshDerivedSources(transaction, decision.proposal_id, now);
        return { result: { proposal_id: decision.proposal_id, status: "applied", already_recorded: false, merged_into: decision.proposal_id }, notify: false, updated_at: now };
      }

      if (decision.kind === "duplicate_rule") {
        const proposalId = insertProposal(transaction, input, {
          id: createUlid(), now, fingerprint: textFingerprint, text, level, role,
          status: "rejected", lastError: `duplicate_of_existing_rule:${decision.rule_id}`,
        });
        insertSource(transaction, input, inputFingerprint, textFingerprint, proposalId, now);
        refreshDerivedSources(transaction, proposalId, now);
        const lastError = `duplicate_of_existing_rule:${decision.rule_id}`;
        return {
          result: { proposal_id: proposalId, status: "rejected", already_recorded: false, last_error: lastError },
          notify: false,
          updated_at: now,
        };
      }

      if (decision.kind === "conflict") {
        const lastError = `conflicts_with_existing_rule:${decision.rule_id}`;
        const proposalId = insertProposal(transaction, input, {
          id: createUlid(), now, fingerprint: textFingerprint, text, level, role,
          status: "rejected", lastError,
        });
        insertSource(transaction, input, inputFingerprint, textFingerprint, proposalId, now);
        refreshDerivedSources(transaction, proposalId, now);
        return { result: { proposal_id: proposalId, status: "rejected", already_recorded: false, last_error: lastError }, notify: false, updated_at: now };
      }

      if (decision.kind === "rejected") {
        const lastError = `suppressed_by_rejection:${decision.proposal_id}`;
        insertSource(transaction, input, inputFingerprint, textFingerprint, decision.proposal_id, now);
        refreshDerivedSources(transaction, decision.proposal_id, now);
        transaction.run("UPDATE rule_proposals SET last_error=?, updated_at=? WHERE id=?", lastError, now, decision.proposal_id);
        return {
          result: { proposal_id: decision.proposal_id, status: "rejected", already_recorded: false, merged_into: decision.proposal_id, last_error: lastError },
          notify: false,
          updated_at: now,
        };
      }

      if (decision.kind === "simulated_open") throw new Error("invalid_simulated_rule_proposal_decision");
      let target = decision.kind === "open" ? decision.target : undefined;
      const isNew = decision.kind === "new";
      if (!target) {
        const id = insertProposal(transaction, input, {
          id: createUlid(), now, fingerprint: textFingerprint, text, level, role, status: "pending", lastError: null,
        });
        target = { id, status: "pending", decision_json: null };
      }
      insertSource(transaction, input, inputFingerprint, textFingerprint, target.id, now);
      // A changed snapshot merges into the open proposal; its rationale is the newest aggregate the Owner must judge.
      if (!isNew && input.origin === "metrics") {
        transaction.run("UPDATE rule_proposals SET rationale=? WHERE id=?", typeof input.rationale === "string" ? input.rationale.trim() : "", target.id);
      }
      const sourceCount = refreshDerivedSources(transaction, target.id, now);
      const wasWaitingForSources = target.status === "pending" && isAwaitingSources(target.decision_json);
      const promote = target.status === "pending" && sourceCount >= this.minSources;
      if (promote) {
        transaction.run(
          "UPDATE rule_proposals SET status='awaiting_approval', decision_json=NULL, last_error=NULL, updated_at=? WHERE id=?",
          now,
          target.id,
        );
      } else if (target.status === "pending") {
        transaction.run(
          "UPDATE rule_proposals SET status='pending', decision_json=?, updated_at=? WHERE id=?",
          JSON.stringify({ reason: "awaiting_sources", decided_by: "validator", have: sourceCount, need: this.minSources }),
          now,
          target.id,
        );
      } else {
        transaction.run("UPDATE rule_proposals SET updated_at=? WHERE id=?", now, target.id);
      }
      return {
        result: {
          proposal_id: target.id,
          status: promote ? "awaiting_approval" : target.status,
          already_recorded: false,
          ...(!isNew ? { merged_into: target.id } : {}),
        },
        notify: promote && (isNew || wasWaitingForSources),
        updated_at: now,
      };
    });

    if (outcome.notify) {
      await this.writeLane.write({
        mutateState: () => undefined,
        event: {
          idempotencyKey: `rule-proposal-awaiting:${outcome.result.proposal_id}:${outcome.updated_at}`,
          type: "rule_proposal.awaiting_approval",
          payload: { proposal_id: outcome.result.proposal_id, status: "awaiting_approval" },
          createdAt: outcome.updated_at,
        },
        outbox: [{ provider: "websocket" }],
      });
    }
    return outcome.result;
  }
}

function prepareCreateInput(input: RuleProposalCreateInput): PreparedCreateInput {
  validateSource(input);
  const text = typeof input.text === "string" ? input.text.trim() : "";
  const level = input.level;
  const role = level === "role" ? input.role ?? null : null;
  if (level !== "system" && level !== "role") throw new Error("invalid_rule_proposal_level");
  if ((level === "role" && (role === null || !isRuleRole(role))) || (level === "system" && input.role !== undefined)) {
    throw new Error("invalid_rule_proposal_role");
  }
  return {
    input,
    text,
    level,
    role,
    textFingerprint: fingerprint(text),
    inputFingerprint: input.input_fingerprint ?? ruleKeyFingerprint(text, level, role),
  };
}

function proposalKey(input: PreparedCreateInput): string {
  return JSON.stringify([input.textFingerprint, input.level, input.role]);
}

function decideCreate(
  input: PreparedCreateInput,
  reader: Pick<CoreDatabase, "get" | "all">,
  ruleStore: Pick<RuleStore, "rules">,
  simulatedOpenKeys?: ReadonlySet<string>,
  judge?: RulePairJudge,
): CreateDecision {
  const { input: original, text, level, role, textFingerprint, inputFingerprint } = input;
  const previousSource = reader.get<SourceRow>(
    `SELECT proposal_id FROM rule_proposal_sources
      WHERE source_kind=? AND source_ref=? AND input_fingerprint=?`,
    original.source.kind,
    original.source.ref,
    inputFingerprint,
  );
  if (previousSource) return { kind: "recorded", proposal_id: previousSource.proposal_id };

  const validationError = validateText(text) ?? serializationError(text, level, role);
  if (validationError) return { kind: "invalid", error: validationError };

  const matchingRule = ruleStore.rules.promptRules.find((rule) => sameRuleKey(rule, textFingerprint, level, role));
  if (matchingRule) {
    const applied = reader.get<{ id: string }>(
      `SELECT id FROM rule_proposals
        WHERE fingerprint=? AND level=? AND role IS ? AND status='applied'
        ORDER BY created_at DESC, id LIMIT 1`,
      textFingerprint,
      level,
      role,
    );
    return applied ? { kind: "applied", proposal_id: applied.id } : { kind: "duplicate_rule", rule_id: matchingRule.id };
  }

  const rejected = reader.get<{ id: string }>(
    `SELECT id FROM rule_proposals
      WHERE fingerprint=? AND level=? AND role IS ? AND status='rejected'
      ORDER BY created_at DESC, id LIMIT 1`,
    textFingerprint,
    level,
    role,
  );
  if (rejected) return { kind: "rejected", proposal_id: rejected.id };

  // Why before open: a proposal that contradicts or repeats an existing rule must not gain sources or reach approval.
  if (judge) {
    const scoped = ruleStore.rules.promptRules.filter((rule) => coApply(rule, { level, role }));
    const conflicting = scoped.find((rule) => judge.get(text, rule.text) === "conflict");
    if (conflicting) return { kind: "conflict", rule_id: conflicting.id };
    const same = scoped.find((rule) => judge.get(text, rule.text) === "same");
    if (same) return { kind: "duplicate_rule", rule_id: same.id };
  }

  const target = reader.get<{ id: string; status: RuleProposalStatus; decision_json: string | null }>(
    `SELECT id, status, decision_json FROM rule_proposals
      WHERE fingerprint=? AND level=? AND role IS ? AND status IN ('pending', 'awaiting_approval')
      ORDER BY created_at, id LIMIT 1`,
    textFingerprint,
    level,
    role,
  );
  if (target) return { kind: "open", target };
  // Why not exact-only: reworded lessons from other Works would each become a separate open proposal.
  const near = reader.all<{ id: string; status: RuleProposalStatus; decision_json: string | null; text: string }>(
    `SELECT id, status, decision_json, text FROM rule_proposals
      WHERE level=? AND role IS ? AND status IN ('pending', 'awaiting_approval')
      ORDER BY created_at, id`,
    level,
    role,
  ).map((row) => ({ row, similarity: dice(text, row.text) }))
    .filter((entry) => entry.similarity >= NEAR_DUPLICATE)
    .sort((a, b) => b.similarity - a.similarity)[0];
  if (near) return { kind: "open", target: { id: near.row.id, status: near.row.status, decision_json: near.row.decision_json } };
  if (judge) {
    const open = reader.all<{ id: string; status: RuleProposalStatus; decision_json: string | null; text: string }>(
      `SELECT id, status, decision_json, text FROM rule_proposals
        WHERE level=? AND role IS ? AND status IN ('pending', 'awaiting_approval')
        ORDER BY created_at, id`,
      level,
      role,
    ).find((row) => judge.get(text, row.text) === "same");
    if (open) return { kind: "open", target: { id: open.id, status: open.status, decision_json: open.decision_json } };
  }
  if (simulatedOpenKeys?.has(proposalKey(input))) return { kind: "simulated_open" };
  return { kind: "new" };
}

function insertProposal(
  transaction: CoreWriteLaneTransaction,
  input: RuleProposalCreateInput,
  values: {
    id: string;
    now: string;
    fingerprint: string;
    text: string;
    level: "system" | "role";
    role: RuleRole | null;
    status: RuleProposalStatus;
    lastError: string | null;
  },
): string {
  const rationale = typeof input.rationale === "string" ? input.rationale.trim() : "";
  const appliesTo = typeof input.applies_to === "string" ? input.applies_to.trim() : "";
  const noteId = input.note_id ?? (input.source.kind === "note" ? input.source.ref.split(":", 1)[0] : null);
  transaction.run(
    `INSERT INTO rule_proposals
       (id, fingerprint, origin, level, role, text, rationale, applies_to, note_id,
        source_work_ids_json, project_id, status, decision_json, attempts, last_error,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, NULL, 0, ?, ?, ?)`,
    values.id,
    values.fingerprint,
    input.origin,
    values.level,
    values.role,
    values.text,
    rationale,
    appliesTo,
    noteId,
    input.project_id ?? null,
    values.status,
    values.lastError,
    values.now,
    values.now,
  );
  return values.id;
}

function insertSource(
  transaction: CoreWriteLaneTransaction,
  input: RuleProposalCreateInput,
  inputFingerprint: string,
  textFingerprint: string,
  proposalId: string,
  now: string,
): void {
  transaction.run(
    `INSERT INTO rule_proposal_sources
       (id, source_kind, source_ref, input_fingerprint, text_fingerprint, proposal_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    createUlid(),
    input.source.kind,
    input.source.ref,
    inputFingerprint,
    textFingerprint,
    proposalId,
    now,
  );
}

function refreshDerivedSources(transaction: CoreWriteLaneTransaction, proposalId: string, now: string): number {
  const workRows = transaction.all<{ source_ref: string }>(
    `SELECT DISTINCT source_ref FROM rule_proposal_sources WHERE proposal_id=? AND source_kind='work' ORDER BY source_ref`,
    proposalId,
  );
  const sourceCount = transaction.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM (
       SELECT DISTINCT source_kind, source_ref FROM rule_proposal_sources WHERE proposal_id=?
     )`,
    proposalId,
  )?.count ?? 0;
  transaction.run(
    "UPDATE rule_proposals SET source_work_ids_json=?, updated_at=? WHERE id=?",
    JSON.stringify(workRows.map(({ source_ref }) => source_ref)),
    now,
    proposalId,
  );
  return sourceCount;
}

function validateText(text: string): string | null {
  const length = [...text].length;
  if (length < 1 || length > 300) return "rule_text_length_invalid";
  if (/[\r\n]/u.test(text)) return "rule_text_must_be_one_line";
  return null;
}

function serializationError(text: string, level: "system" | "role", role: RuleRole | null): string | null {
  const file = {
    path: "proposal-preview.yaml",
    level,
    ...(level === "role" && role ? { role } : {}),
    rules: [{ id: "proposal-preview", kind: "instruction" as const, text }],
  };
  try {
    const parsed = parseRuleYaml(renderRuleFile(file), file.path);
    return parsed.rules[0]?.text === text ? null : "text_not_serializable";
  } catch (error) {
    return isRecord(error) && error.code === "text_not_serializable" ? "text_not_serializable" : "text_not_serializable";
  }
}

function sameRuleKey(rule: PromptRule, textFingerprint: string, level: "system" | "role", role: RuleRole | null): boolean {
  return fingerprint(rule.text) === textFingerprint && rule.level === level && (rule.role ?? null) === role;
}

function validateSource(input: RuleProposalCreateInput): void {
  if (!input || !input.source || typeof input.source.ref !== "string" || input.source.ref.trim().length === 0) {
    throw new Error("invalid_rule_proposal_source");
  }
  const sourceKinds: readonly string[] = ["work", "note", "legacy_policy", "decision", "metrics_snapshot"];
  if (!sourceKinds.includes(input.source.kind)) throw new Error("invalid_rule_proposal_source");
  if (input.origin === "lesson" && input.source.kind !== "work") throw new Error("invalid_rule_proposal_source");
  if (input.origin === "note" && input.source.kind !== "note") throw new Error("invalid_rule_proposal_source");
  if (input.origin === "metrics" && input.source.kind !== "metrics_snapshot") throw new Error("invalid_rule_proposal_source");
  if (input.origin === "legacy_policy" &&input.source.kind !== "legacy_policy" && input.source.kind !== "decision") {
    throw new Error("invalid_rule_proposal_source");
  }
}

function isAwaitingSources(json: string | null): boolean {
  if (!json) return false;
  const decision = parseJson(json);
  return isRecord(decision) && decision.reason === "awaiting_sources";
}

function parseStringArray(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseJson(json: string | null): unknown {
  if (!json) return null;
  try { return JSON.parse(json) as unknown; } catch { return null; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProposalStatus(value: string): value is RuleProposalStatus {
  return ["pending", "awaiting_approval", "applied", "rejected", "expired", "merged"].includes(value);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value as number : fallback;
}
