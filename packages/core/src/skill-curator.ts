import { createUlid } from "../../db/dist/index.js";
import type {
  CuratorCandidate,
  CuratorJudgement,
  CuratorProposal,
  CuratorRequest,
  CuratorResultItem,
  CuratorRunResult,
} from "@owl/shared";
import type { AgentRunner, CoreDatabase, CoreWriteLaneTransaction } from "./types.js";
import type { SkillBox, SkillRecord } from "./skill-box.js";
import { hashSkillFiles, parseSkillMd, renderSkillMd, validateSkillFilePath, validateSkillName } from "./skill-files.js";

export interface SkillCurationResult {
  target: { skills: number; open_proposals: number };
  state_changes: Array<{ skill: string; from: string; to: string; reason: string | null }>;
  trial_results: Array<{ skill: string; result: "graduated" | "rolled_back" | "archived" | "continuing" }>;
  proposals: Array<{ id: string; target: string | null; kind: string; from: string; to: string; reason: string | null; attempts: number }>;
  automatic_proposals: Array<{ id: string; target: string | null; kind: string }>;
  /** Content changes: state_changes alone miss new skills and in-place updates. */
  applied: Array<{ id: string; target: string | null }>;
  trials_ended: Array<{ skill: string; result: string }>;
  pending_remaining: number;
  awaiting_approval: Array<{ id: string; target: string | null; kind: string }>;
  warnings: string[];
}

export type SkillCuratorMode = "autonomous" | "conservative";
export const SKILL_CURATOR_DEBOUNCE_MS = 5_000;
export type JudgementRoute =
  | { readonly route: "rejected"; readonly operation: "create" | "update" }
  | { readonly route: "awaiting_approval"; readonly operation: "create" | "update" }
  | { readonly route: "write"; readonly operation: "create" | "update" };

export interface SkillCuratorOptions {
  readonly db: CoreDatabase;
  readonly skillBox: SkillBox;
  readonly agentRunner: Pick<AgentRunner, "runCurator">;
  readonly getTypesafeApiKey?: () => string;
  readonly getModelConfig?: () => { readonly model: string; readonly provider: string; readonly effort?: string } | undefined;
  readonly typeSafeJudge?: (input: {
    readonly api_key: string;
    readonly proposal: CuratorProposal;
    readonly candidates: readonly CuratorCandidate[];
  }) => Promise<unknown>;
  readonly now?: () => string;
  /** Memory catalog for the Curator input. */
  readonly composeKnowledge?: (proposals: readonly CuratorProposal[]) => Promise<string | null>;
  readonly debounce_ms?: number;
  readonly logger?: Pick<Console, "warn" | "error">;
}

type CuratorRunKind = "pending" | "lifecycle" | "tick";

interface SkillProposalRow {
  readonly id: string;
  readonly payload_json: string;
  readonly project_id: string | null;
  readonly source_work_id: string | null;
  readonly source_agent_run_id: string | null;
  readonly target_skill: string | null;
  readonly attempts: number;
  readonly status: string;
  readonly decision_json?: string | null;
}

interface SkillSummary {
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly scope?: string;
  readonly project_id?: string | null;
  readonly state?: string;
}

interface SkillSettings {
  readonly mode: SkillCuratorMode;
  readonly confidence_threshold: number;
  readonly stale_days: number;
  readonly archived_days: number;
  readonly trial_unused_days: number;
}

interface PreparedSkillWrite {
  readonly proposal_id: string;
  readonly target_name: string;
  readonly target_revision: number | null;
  readonly files: Record<string, string>;
  readonly meta: { readonly description: string; readonly tags: readonly string[]; readonly scope: string };
  readonly action: "create" | "update" | "merge";
  readonly archive: readonly string[];
  readonly reason: string;
  readonly source_proposal_id: string;
  readonly source_work_id: string | null;
  readonly source_agent_run_id: string | null;
  readonly project_id: string | null;
  readonly relation: "same" | "extends" | "different";
  readonly judgement?: CuratorJudgement;
}

export function prefilterProposal(value: unknown): string | null {
  if (!isRecord(value)) return "proposal_fields_empty";
  const fields = [value.summary, value.steps_or_diff, value.evidence];
  if (fields.some((field) => typeof field !== "string" || field.trim().length === 0)) return "proposal_fields_empty";
  if ((value.steps_or_diff as string).trim().length < 40) return "procedure_too_short";
  return null;
}

export function normalizeJudgement(value: unknown): CuratorJudgement | null {
  if (!isRecord(value)) return null;
  const { reusable, work_specific: workSpecific, relation, confidence } = value;
  if (typeof reusable !== "number" || !Number.isFinite(reusable) || reusable < 0 || reusable > 2) return null;
  if (typeof workSpecific !== "number" || !Number.isFinite(workSpecific) || workSpecific < 0 || workSpecific > 1) return null;
  if (relation !== "same" && relation !== "extends" && relation !== "different") return null;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  return { reusable, work_specific: workSpecific, relation, confidence };
}

export function routeJudgement(
  judgement: CuratorJudgement,
  mode: SkillCuratorMode,
  confidenceThreshold: number,
  proposalKind: "new" | "update",
): JudgementRoute {
  const operation = proposalKind === "update" || judgement.relation === "same" || judgement.relation === "extends" ? "update" : "create";
  if (judgement.reusable < 1 || judgement.work_specific >= 0.5 || judgement.confidence < confidenceThreshold) {
    return { route: "rejected", operation };
  }
  return mode === "conservative"
    ? { route: "awaiting_approval", operation }
    : { route: "write", operation };
}

export function selectSkillCandidates<T extends SkillSummary>(proposal: {
  readonly summary: string;
  readonly steps_or_diff: string;
  readonly evidence: string;
  readonly target?: string | null;
}, skills: readonly T[]): T[] {
  const proposalTerms = words(`${proposal.summary} ${proposal.steps_or_diff} ${proposal.evidence}`);
  const target = typeof proposal.target === "string" ? proposal.target : null;
  return skills
    .map((skill) => {
      const skillTerms = words(`${skill.name} ${skill.description} ${skill.tags.join(" ")}`);
      const score = [...skillTerms].reduce((sum, term) => sum + Number(proposalTerms.has(term)), 0);
      return { skill, score: skill.name === target ? score + 1000 : score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name))
    .slice(0, 3)
    .map((entry) => entry.skill);
}

export async function judgeWithTypeSafe(
  apiKey: string,
  proposal: CuratorProposal,
  candidates: readonly CuratorCandidate[],
): Promise<CuratorJudgement> {
  const { TypeSafeClient, score, noul, choice } = await import("@typesafe-ai/sdk");
  const client = new TypeSafeClient({ apiKey });
  const relationQuestions = Object.fromEntries(candidates.map((candidate, index) => [
    `relation_${index}`,
    choice(`How does the proposal relate to candidate skill ${candidate.name}?`, {
      same: "The proposal describes the same skill with no meaningful extension.",
      extends: "The proposal extends or improves this candidate skill.",
      different: "The proposal is a separate procedure.",
    }),
  ]));
  const response = await client.systemOne({
    state: {
      proposal: { ...proposal.payload },
      candidates: candidates.map((candidate) => ({
        name: candidate.name,
        description: candidate.description,
        files: { ...candidate.files },
      })),
    },
    questions: {
      reusable: score("Can this procedure be reused across multiple Works?", [
        "No, it is one-time work.",
        "Yes, it can be reused within the same project.",
        "Yes, it can be reused across projects.",
      ]),
      work_specific: noul("Does this depend on one specific Work, issue, or date?", {
        true: "The steps depend on a specific Work, issue, or date.",
        false: "The steps remain useful independent of one Work or date.",
      }),
      ...relationQuestions,
    },
  });
  const reusable = response.answers.reusable;
  const specificity = response.answers.work_specific;
  const answerMap = response.answers as Record<string, unknown>;
  const relationAnswers = candidates.map((_, index) => answerMap[`relation_${index}`]).filter(isRecord);
  const relations = relationAnswers.map((answer) => answer.choice).filter((value): value is "same" | "extends" | "different" => value === "same" || value === "extends" || value === "different");
  if (relations.length !== candidates.length) throw new Error("typesafe_relation_invalid");
  const relationConfidence = relationAnswers.map((answer) => answer.confidence).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (relationConfidence.length !== relationAnswers.length) throw new Error("typesafe_relation_confidence_invalid");
  return {
    reusable: reusable.score,
    work_specific: specificity.noul,
    relation: relations.includes("same") ? "same" : relations.includes("extends") ? "extends" : "different",
    confidence: Math.min(reusable.confidence, ...relationConfidence, specificity.noul >= 0.5 ? specificity.noul : 1 - specificity.noul),
  };
}

export class SkillCurator {
  private readonly db: CoreDatabase;
  private readonly writeLane;
  private readonly skillBox: SkillBox;
  private readonly agentRunner: Pick<AgentRunner, "runCurator">;
  private readonly getTypesafeApiKey?: () => string;
  private readonly getModelConfig?: SkillCuratorOptions["getModelConfig"];
  private readonly typeSafeJudge?: SkillCuratorOptions["typeSafeJudge"];
  private readonly now: () => string;
  private readonly composeKnowledge?: SkillCuratorOptions["composeKnowledge"];
  private readonly logger: Pick<Console, "warn" | "error">;
  private readonly debounceMs: number;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private rerunRequested = false;
  private rerunKind: CuratorRunKind | null = null;
  private stopped = false;
  private stopSignal: Promise<void> = Promise.resolve();
  private signalStop: () => void = () => undefined;

  public constructor(options: SkillCuratorOptions) {
    this.db = options.db;
    this.writeLane = options.db.createWriteLane();
    this.skillBox = options.skillBox;
    this.agentRunner = options.agentRunner;
    this.getTypesafeApiKey = options.getTypesafeApiKey;
    this.getModelConfig = options.getModelConfig;
    this.typeSafeJudge = options.typeSafeJudge;
    this.now = options.now ?? (() => new Date().toISOString());
    this.composeKnowledge = options.composeKnowledge;
    this.logger = options.logger ?? console;
    this.debounceMs = typeof options.debounce_ms === "number" && Number.isFinite(options.debounce_ms) && options.debounce_ms >= 0
      ? options.debounce_ms
      : SKILL_CURATOR_DEBOUNCE_MS;
    this.start();
  }

  public start(): void {
    this.stopped = false;
    this.stopSignal = new Promise<void>((resolve) => { this.signalStop = resolve; });
  }

  public processPending(): Promise<void> {
    return this.requestRun("pending");
  }

  public tick(): Promise<void> {
    return this.requestRun("tick");
  }

  public schedule(): void {
    if (this.stopped) return;
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      // Why not log: processPending handles its own errors per run; the timer callback has no caller to tell.
      void this.processPending();
    }, this.debounceMs);
    this.debounceTimer.unref?.();
  }

  public stop(): void {
    this.stopped = true;
    this.signalStop();
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private requestRun(kind: CuratorRunKind): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) {
      this.rerunRequested = true;
      if (runKindPriority(kind) > runKindPriority(this.rerunKind ?? "pending")) this.rerunKind = kind;
      return this.inFlight;
    }
    const operation = (async () => {
      let nextKind = kind;
      try {
        do {
          this.rerunRequested = false;
          this.rerunKind = null;
          await this.skillBox.enqueue(async () => {
            if (nextKind === "tick") {
              try {
                await this.skillBox.reconcileFiles();
              } catch (error) {
                this.logger.warn(`[skill-curator] Skill reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
              }
              await this.evaluateLifecycleNow();
              await this.processPendingNow();
            } else if (nextKind === "lifecycle") {
              await this.evaluateLifecycleNow();
            } else {
              await this.processPendingNow();
            }
          });
          if (this.rerunRequested) nextKind = this.rerunKind ?? "pending";
        } while (this.rerunRequested && !this.stopped);
      } catch (error) {
        this.logger.error(`[skill-curator] Curator run failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        // Cleared in the same turn as the loop's last check so that a request
        // arriving afterwards starts a new run instead of being dropped.
        this.inFlight = null;
      }
    })();
    this.inFlight = operation;
    return operation;
  }

  /** One batched pass: reconcile, evaluate trials and staleness, then drain pending proposals; returns what changed. */
  public curate(options: { readonly maxBatches?: number } = {}): Promise<SkillCurationResult> {
    return this.skillBox.enqueue(async () => {
      const snapshot = () => new Map(this.skillBox.listSkills({ include_broken: true }).map((s) => [s.name, s]));
      const openProposals = () => this.db.all<{ id: string; status: string; kind: string; target_skill: string | null; attempts: number; last_error: string | null; decision_json: string | null; created_at: string }>(
        `SELECT id, status, kind, target_skill, attempts, last_error, decision_json, created_at
           FROM skill_proposals WHERE status IN ('pending', 'awaiting_approval') ORDER BY created_at ASC, id ASC`,
      );
      const before = snapshot();
      const openBefore = new Map(openProposals().map((p) => [p.id, p]));
      const idsBefore = new Set(this.db.all<{ id: string }>("SELECT id FROM skill_proposals").map((r) => r.id));
      const revisionsBefore = new Map([...before.keys()].map((name) => [name, this.db.get<{ r: number | null }>("SELECT MAX(revision) AS r FROM skill_revisions WHERE skill_name = ?", name)?.r ?? 0]));
      const warnings: string[] = [];
      try {
        await this.skillBox.reconcileFiles();
      } catch (error) {
        warnings.push(`reconcile_failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await this.evaluateLifecycleNow();
      if (typeof this.agentRunner.runCurator !== "function") {
        warnings.push("curator_unavailable");
      } else {
        // Drain every pending proposal (5 per batch), including ones created during the run. A failed one retries until its
        // attempts run out, so the id:attempts signature stops changing and the loop ends.
        const signature = () => openProposals().filter((p) => p.status === "pending").map((p) => `${p.id}:${p.attempts}`).join(",");
        let batches = 0;
        for (;;) {
          const pendingBefore = signature();
          if (pendingBefore === "") break;
          if (options.maxBatches !== undefined && batches >= options.maxBatches) {
            warnings.push(`max_batches_reached: stopped after ${batches} batches`);
            break;
          }
          await this.processPendingNow();
          batches += 1;
          if (signature() === pendingBefore) {
            warnings.push("no_progress: pending proposals did not change after a batch");
            break;
          }
        }
      }

      const after = snapshot();
      const state_changes: SkillCurationResult["state_changes"] = [];
      const trial_results: SkillCurationResult["trial_results"] = [];
      for (const [name, prev] of before) {
        const next = after.get(name);
        if (!next) continue;
        if (next.state !== prev.state) {
          const reason = this.db.get<{ reason: string }>(
            "SELECT reason FROM skill_revisions WHERE skill_name = ? AND actor = 'curator' AND revision > ? ORDER BY revision DESC LIMIT 1",
            name,
            revisionsBefore.get(name) ?? 0,
          )?.reason ?? null;
          state_changes.push({ skill: name, from: prev.state, to: next.state, reason });
        }
        if (prev.trial === 1) {
          const result = next.state === "archived" ? "archived"
            : next.current_revision !== prev.current_revision && next.trial === 0 ? "rolled_back"
            : next.trial === 0 ? "graduated"
            : "continuing";
          trial_results.push({ skill: name, result });
        }
      }
      const openAfter = new Map(openProposals().map((p) => [p.id, p]));
      const proposals: SkillCurationResult["proposals"] = [];
      const createdDuring = this.db.all<{ id: string; status: string; kind: string; target_skill: string | null; attempts: number; last_error: string | null; decision_json: string | null; created_at: string }>(
        "SELECT id, status, kind, target_skill, attempts, last_error, decision_json, created_at FROM skill_proposals ORDER BY created_at ASC, id ASC",
      ).filter((p) => !idsBefore.has(p.id));
      const touched = new Map([...openBefore, ...createdDuring.map((p) => [p.id, { ...p, status: "pending", attempts: 0, last_error: null }] as const)]);
      for (const [id, prev] of touched) {
        const created = !openBefore.has(id);
        const now = openAfter.get(id);
        if (!created && now?.status === prev.status && now.attempts === prev.attempts && now.last_error === prev.last_error) continue;
        const row = now ?? this.db.get<typeof prev>("SELECT id, status, kind, target_skill, attempts, last_error, decision_json, created_at FROM skill_proposals WHERE id = ?", id) ?? prev;
        proposals.push({ id, target: prev.target_skill, kind: prev.kind, from: created ? "created" : prev.status, to: row.status, reason: row.last_error ?? decisionReason(row.decision_json), attempts: row.attempts });
      }
      const brief = (p: { id: string; target_skill: string | null; kind: string }) => ({ id: p.id, target: p.target_skill, kind: p.kind });
      return {
        target: { skills: before.size, open_proposals: openBefore.size },
        state_changes,
        trial_results,
        proposals,
        automatic_proposals: createdDuring.map(brief),
        applied: proposals.filter((p) => p.to === "applied").map((p) => ({ id: p.id, target: p.target })),
        trials_ended: trial_results.filter((t) => t.result !== "continuing"),
        pending_remaining: [...openAfter.values()].filter((p) => p.status === "pending").length,
        awaiting_approval: [...openAfter.values()].filter((p) => p.status === "awaiting_approval").map(brief),
        warnings,
      };
    });
  }

  private async processPendingNow(): Promise<void> {
    const pending = this.db.all<SkillProposalRow>(
      `SELECT id, payload_json, project_id, source_work_id, source_agent_run_id, target_skill, attempts, status
         FROM skill_proposals WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT 5`,
    );
    if (pending.length === 0) return;
    const runCurator = this.agentRunner.runCurator;
    if (typeof runCurator !== "function") {
      this.logger.warn("[skill-curator] Curator is unavailable; pending proposals remain queued.");
      return;
    }

    const proposals: CuratorProposal[] = [];
    for (const row of pending) {
      if (row.attempts >= 3) {
        await this.updateProposal(row.id, "rejected", "curator_attempts_exhausted", null);
        continue;
      }
      const payload = parseProposal(row.payload_json);
      const problem = prefilterProposal(payload);
      if (problem || !payload) {
        await this.updateProposal(row.id, "rejected", problem ?? "proposal_payload_invalid", null);
        continue;
      }
      proposals.push({ id: row.id, payload, project_id: row.project_id, candidate_skill_names: [] });
    }
    if (proposals.length === 0) return;

    const allSkills = this.skillBox.listSkills({ include_broken: true });
    const candidateByName = new Map<string, CuratorCandidate>();
    const candidateSkills = new Map<string, SkillRecord>();
    for (let index = 0; index < proposals.length; index += 1) {
      const proposal = proposals[index]!;
      const matches = selectSkillCandidates(proposal.payload, allSkills);
      proposals[index] = { ...proposal, candidate_skill_names: matches.map((skill) => skill.name) };
      for (const skill of matches) {
        const files = this.currentFiles(skill.name, skill.current_revision);
        if (!files) continue;
        candidateByName.set(skill.name, { name: skill.name, description: skill.description, files });
        candidateSkills.set(skill.name, skill);
      }
    }
    const candidates = [...candidateByName.values()];
    const settings = this.settings();
    const apiKey = this.getTypesafeApiKey?.().trim() || undefined;
    const typesafeJudgements = new Map<string, CuratorJudgement>();
    const fallbackIds = new Set<string>();

    if (apiKey) {
      for (const proposal of proposals) {
        const proposalCandidates = proposal.candidate_skill_names
          .flatMap((name) => candidateByName.has(name) ? [candidateByName.get(name)!] : []);
        try {
          const raw = this.typeSafeJudge
            ? await this.typeSafeJudge({ api_key: apiKey, proposal, candidates: proposalCandidates })
            : await judgeWithTypeSafe(apiKey, proposal, proposalCandidates);
          const judgement = normalizeJudgement(raw);
          if (!judgement) throw new Error("typesafe_judgement_invalid");
          typesafeJudgements.set(proposal.id, judgement);
        } catch (error) {
          fallbackIds.add(proposal.id);
          this.logger.warn(`[skill-curator] TypeSafe judgement failed for proposal ${proposal.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } else {
      for (const proposal of proposals) fallbackIds.add(proposal.id);
    }

    const writing: CuratorProposal[] = [];
    for (const proposal of proposals) {
      const judgement = typesafeJudgements.get(proposal.id);
      if (!judgement) {
        writing.push(proposal);
        continue;
      }
      const route = routeJudgement(judgement, settings.mode, settings.confidence_threshold, proposal.payload.kind);
      if (route.route === "rejected") {
        const reason = judgementReason(judgement, settings.confidence_threshold);
        await this.updateProposal(proposal.id, "rejected", reason, { judgement, reason });
      } else if (route.route === "awaiting_approval") {
        await this.updateProposal(proposal.id, "awaiting_approval", null, { judgement, needs_writing: true });
      } else {
        writing.push(proposal);
      }
    }
    if (writing.length === 0) return;

    const targetNames = new Set<string>(candidateSkills.keys());
    for (const proposal of writing) {
      if (proposal.payload.target) targetNames.add(proposal.payload.target);
    }
    const usages = this.recentUsages([...targetNames]);
    const model = this.getModelConfig?.();
    const request: CuratorRequest = {
      proposals: writing,
      skill_index: allSkills.map((skill) => ({ name: skill.name, description: skill.description })),
      candidates,
      usages,
      with_judgement: writing.some((proposal) => fallbackIds.has(proposal.id)),
      knowledge: await this.composeKnowledge?.(writing),
      ...(model ? { model: model.model, provider: model.provider, effort: model.effort } : {}),
    };
    await this.beginAttempts(writing.map((proposal) => proposal.id));
    const result = await this.callCurator(runCurator, request);
    if (result === null) return;
    if (!result.ok) {
      for (const proposal of writing) {
        await this.failProposal(proposal.id, result.error, { ...(typesafeJudgements.has(proposal.id) ? { judgement: typesafeJudgements.get(proposal.id) } : {}) });
      }
      return;
    }
    const byId = new Map(result.results.map((item) => [item.proposal_id, item]));
    for (const proposal of writing) {
      const item = byId.get(proposal.id);
      if (!item) {
        await this.failProposal(proposal.id, "curator_result_missing", null);
        continue;
      }
      const judgement = typesafeJudgements.get(proposal.id) ?? normalizeJudgement(item.judgement);
      if (!judgement) {
        await this.failProposal(proposal.id, "curator_judgement_invalid", item);
        continue;
      }
      if (item.decision === "reject") {
        await this.updateProposal(proposal.id, "rejected", item.reason, { ...item, judgement });
        continue;
      }
      const route = routeJudgement(judgement, settings.mode, settings.confidence_threshold, proposal.payload.kind);
      if (route.route === "rejected") {
        await this.updateProposal(proposal.id, "rejected", judgementReason(judgement, settings.confidence_threshold), { ...item, judgement });
      } else {
        try {
          const prepared = this.prepareWrite(proposal, item, judgement, route.operation);
          if (route.route === "awaiting_approval" || this.hasChangedScriptFiles(prepared)) {
            await this.updateProposal(proposal.id, "awaiting_approval", null, prepared);
            continue;
          }
          await this.applyPreparedWrite(prepared);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (reason === "proposal_no_improvement") await this.updateProposal(proposal.id, "rejected", reason, { ...item, judgement });
          else await this.failProposal(proposal.id, reason, { ...item, judgement });
        }
      }
    }
  }

  public approveProposal(proposalId: string): Promise<void> {
    return this.skillBox.enqueue(async () => {
      const row = this.proposal(proposalId);
      if (!row || row.status !== "awaiting_approval" || !row.decision_json) throw new Error("skill_proposal_not_awaiting_approval");
      const decision: unknown = parseJson(row.decision_json);
      if (isPreparedWrite(decision)) {
        await this.beginAttempts([row.id], "awaiting_approval");
        try {
          await this.applyPreparedWrite(decision);
        } catch (error) {
          await this.failApproval(row.id, error instanceof Error ? error.message : String(error), decision);
        }
        return;
      }
      if (isRecord(decision) && decision.needs_writing === true) {
        await this.writeApprovedProposal(row, decision);
        return;
      }
      throw new Error("skill_proposal_decision_invalid");
    });
  }

  public rejectProposal(proposalId: string, reason = "Rejected by user."): Promise<void> {
    return this.skillBox.enqueue(async () => {
      const row = this.proposal(proposalId);
      if (!row || row.status !== "awaiting_approval") throw new Error("skill_proposal_not_awaiting_approval");
      await this.updateProposal(proposalId, "rejected", reason, row.decision_json ? parseJson(row.decision_json) : null);
    });
  }

  public evaluateLifecycle(): Promise<void> {
    return this.requestRun("lifecycle");
  }

  private async evaluateLifecycleNow(): Promise<void> {
    const settings = this.settings();
    for (const listed of this.skillBox.listSkills({ include_broken: true })) {
      let skill = this.skillBox.getSkill(listed.name);
      if (!skill || skill.broken_reason !== null) continue;
      await this.evaluateTrial(skill);
      skill = this.skillBox.getSkill(listed.name);
      if (!skill) continue;
      await this.metabolize(skill, settings);
      skill = this.skillBox.getSkill(listed.name);
      if (skill?.state === "active" && skill.trial === 0) await this.createAutomaticProposal(skill);
    }
  }

  private async evaluateTrial(skill: SkillRecord): Promise<void> {
    if (skill.trial !== 1) return;
    const usages = this.db.all<{ verdict: string; note: string | null }>(
      `SELECT verdict, note FROM skill_usages
        WHERE skill_name = ? AND revision = ? AND verdict IS NOT NULL
        ORDER BY updated_at DESC, agent_run_id DESC`,
      skill.name,
      skill.current_revision,
    );
    const misleading = usages.filter((usage) => usage.verdict === "misleading").length;
    if (misleading >= 2) {
      const current = this.db.get<{ action: string }>(
        "SELECT action FROM skill_revisions WHERE skill_name = ? AND revision = ?",
        skill.name,
        skill.current_revision,
      );
      if (current?.action === "create") {
        await this.skillBox.setTrial(skill.name, false);
        if (skill.state !== "archived") await this.skillBox.setState(skill.name, "archived", "curator", "The initial revision received repeated misleading feedback.", "rollback");
        return;
      }
      const previous = this.db.get<{ revision: number; snapshot_json: string }>(
        `SELECT revision, snapshot_json FROM skill_revisions
          WHERE skill_name = ? AND revision < ? AND snapshot_json IS NOT NULL
          ORDER BY revision DESC LIMIT 1`,
        skill.name,
        skill.current_revision,
      );
      const files = previous ? parseSnapshot(previous.snapshot_json) : null;
      const parsed = files ? parseSkillMd(files["SKILL.md"] ?? "") : null;
      if (!files || !parsed || "error" in parsed || parsed.name !== skill.name) {
        await this.skillBox.setTrial(skill.name, false);
        if (skill.state !== "archived") await this.skillBox.setState(skill.name, "archived", "curator", "The trial revision could not be restored safely.", "rollback");
        return;
      }
      await this.skillBox.applyRevision({
        name: skill.name,
        files,
        meta: { description: parsed.description, tags: parsed.tags, scope: parsed.scope },
        actor: "curator",
        action: "rollback",
        reason: `Rolled back after ${misleading} misleading verdicts on revision ${skill.current_revision}.`,
        trial: false,
      });
      return;
    }
    if (usages.length >= 3) await this.skillBox.setTrial(skill.name, false);
  }

  private async metabolize(skill: SkillRecord, settings: SkillSettings): Promise<void> {
    const now = Date.parse(this.now());
    if (!Number.isFinite(now)) return;
    if (skill.state === "active") {
      if (skill.trial === 1) {
        const used = this.db.get<{ found: number }>(
          `SELECT 1 AS found FROM skill_usages
            WHERE skill_name = ? AND revision = ? AND (read_detected = 1 OR verdict IS NOT NULL) LIMIT 1`,
          skill.name,
          skill.current_revision,
        );
        const revisedAt = this.db.get<{ created_at: string }>(
          "SELECT created_at FROM skill_revisions WHERE skill_name = ? AND revision = ?",
          skill.name,
          skill.current_revision,
        )?.created_at;
        const since = Math.max(revisedAt ? Date.parse(revisedAt) : 0, Date.parse(skill.state_changed_at));
        if (!used && Number.isFinite(since) && now - since >= settings.trial_unused_days * 24 * 60 * 60 * 1000) {
          await this.skillBox.setState(skill.name, "stale", "curator", `Trial skill had no detected reads or feedback for ${settings.trial_unused_days} days.`);
          return;
        }
      }
      const activity = this.db.get<{ last_activity: string | null }>(
        `SELECT MAX(updated_at) AS last_activity FROM skill_usages
          WHERE skill_name = ? AND (read_detected = 1 OR verdict IS NOT NULL)`,
        skill.name,
      )?.last_activity;
      const baseline = Math.max(Date.parse(skill.updated_at), Date.parse(skill.state_changed_at), activity ? Date.parse(activity) : 0);
      if (Number.isFinite(baseline) && now - baseline >= settings.stale_days * 24 * 60 * 60 * 1000) {
        await this.skillBox.setState(skill.name, "stale", "curator", `No detected reads or feedback for ${settings.stale_days} days.`);
      }
      return;
    }
    if (skill.state !== "stale") return;
    const helpful = this.db.get<{ found: number }>(
      `SELECT 1 AS found FROM skill_usages
        WHERE skill_name = ? AND verdict = 'helpful' AND updated_at >= ? LIMIT 1`,
      skill.name,
      skill.state_changed_at,
    );
    if (helpful) {
      await this.skillBox.setState(skill.name, "active", "curator", "A helpful use revived this stale skill.");
      return;
    }
    const staleSince = Date.parse(skill.state_changed_at);
    if (Number.isFinite(staleSince) && now - staleSince >= settings.archived_days * 24 * 60 * 60 * 1000) {
      await this.skillBox.setState(skill.name, "archived", "curator", `Remained stale for ${settings.archived_days} days.`);
    }
  }

  private async createAutomaticProposal(skill: SkillRecord): Promise<void> {
    const usages = this.db.all<{ verdict: string; note: string | null }>(
      `SELECT verdict, note FROM skill_usages
        WHERE skill_name = ? AND revision = ? AND verdict IS NOT NULL
        ORDER BY updated_at DESC, agent_run_id DESC LIMIT 5`,
      skill.name,
      skill.current_revision,
    );
    const misleading = usages.filter((usage) => usage.verdict === "misleading");
    const irrelevant = usages.filter((usage) => usage.verdict === "irrelevant");
    if (misleading.length < 2 && irrelevant.length < 3) return;
    const existing = this.db.all<{ payload_json: string }>(
      "SELECT payload_json FROM skill_proposals WHERE target_skill = ?",
      skill.name,
    );
    if (existing.some((row) => {
      const payload = parseJson(row.payload_json);
      return isRecord(payload) && payload.automatic_skill_revision === skill.current_revision;
    })) return;

    const notes = [...misleading, ...irrelevant].map((usage) => usage.note?.trim()).filter((note): note is string => Boolean(note));
    const onlyIrrelevant = misleading.length < 2;
    const summary = onlyIrrelevant
      ? `Clarify when to use ${skill.name}`
      : `Review feedback on ${skill.name}`;
    const steps = onlyIrrelevant
      ? `Narrow the description to identify the conditions where this skill applies and the cases where it should not be used. Recent feedback: ${notes.join(" ") || "No notes were supplied."}`
      : `Review each misleading note, correct the affected steps, and keep the rest of the current procedure intact. Recent feedback: ${notes.join(" ") || "No notes were supplied."}`;
    const payload = {
      kind: "update",
      target: skill.name,
      summary,
      steps_or_diff: steps,
      evidence: `Generated from the five most recent verdicts on revision ${skill.current_revision}.`,
      automatic_skill_revision: skill.current_revision,
    };
    const id = createUlid();
    const now = this.now();
    await this.writeLane.transact((transaction: CoreWriteLaneTransaction) => {
      transaction.run(
        `INSERT INTO skill_proposals
           (id, kind, target_skill, payload_json, project_id, status, attempts, created_at, updated_at)
         VALUES (?, 'update', ?, ?, ?, 'pending', 0, ?, ?)`,
        id,
        skill.name,
        JSON.stringify(payload),
        skill.project_id,
        now,
        now,
      );
    });
  }

  private settings(): SkillSettings {
    const row = this.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'skills'");
    if (!row) return { mode: "autonomous", confidence_threshold: 0.5, stale_days: 60, archived_days: 30, trial_unused_days: 14 };
    try {
      const value: unknown = JSON.parse(row.value_json);
      if (!isRecord(value)) return { mode: "autonomous", confidence_threshold: 0.5, stale_days: 60, archived_days: 30, trial_unused_days: 14 };
      const mode: SkillCuratorMode = value.mode === "conservative" ? "conservative" : "autonomous";
      const configuredThreshold = value.confidence_threshold ?? value.threshold;
      const threshold = typeof configuredThreshold === "number" && Number.isFinite(configuredThreshold)
        ? Math.min(1, Math.max(0, configuredThreshold))
        : 0.5;
      return {
        mode,
        confidence_threshold: threshold,
        stale_days: positiveDays(value.stale_days ?? value.stale_after_days, 60),
        archived_days: positiveDays(value.archived_days ?? value.archive_after_days, 30),
        trial_unused_days: positiveDays(value.trial_unused_days, 14),
      };
    } catch (error) {
      console.warn("[owl-core] Could not parse the skills setting; using defaults.", error);
      return { mode: "autonomous", confidence_threshold: 0.5, stale_days: 60, archived_days: 30, trial_unused_days: 14 };
    }
  }

  private currentFiles(name: string, revision: number): Record<string, string> | null {
    const row = this.db.get<{ snapshot_json: string | null }>(
      "SELECT snapshot_json FROM skill_revisions WHERE skill_name = ? AND revision = ?",
      name,
      revision,
    );
    if (!row?.snapshot_json) return null;
    try {
      const parsed: unknown = JSON.parse(row.snapshot_json);
      return isRecord(parsed) && Object.values(parsed).every((content) => typeof content === "string")
        ? parsed as Record<string, string>
        : null;
    } catch (error) {
      console.warn(`[owl-core] Could not parse the snapshot of ${name} revision ${revision}.`, error);
      return null;
    }
  }

  private recentUsages(skillNames: readonly string[]) {
    if (skillNames.length === 0) return [];
    const names = [...new Set(skillNames)];
    const placeholders = names.map(() => "?").join(", ");
    return this.db.all<{
      skill_name: string;
      revision: number;
      role: string | null;
      verdict: "helpful" | "misleading" | "irrelevant" | null;
      note: string | null;
    }>(
      `SELECT skill_name, revision, role, verdict, note FROM skill_usages
        WHERE skill_name IN (${placeholders}) ORDER BY updated_at DESC LIMIT 10`,
      ...names,
    );
  }

  private proposal(id: string): (SkillProposalRow & { readonly decision_json: string | null }) | undefined {
    return this.db.get<SkillProposalRow & { readonly decision_json: string | null }>(
      `SELECT id, payload_json, project_id, source_work_id, source_agent_run_id, target_skill,
              attempts, status, decision_json
         FROM skill_proposals WHERE id = ?`,
      id,
    );
  }

  private async beginAttempts(ids: readonly string[], status: "pending" | "awaiting_approval" = "pending"): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(", ");
    await this.writeLane.transact((transaction: CoreWriteLaneTransaction) => {
      transaction.run(
        `UPDATE skill_proposals SET attempts = attempts + 1, last_error = NULL, updated_at = ?
          WHERE status = ? AND id IN (${placeholders})`,
        this.now(),
        status,
        ...ids,
      );
    });
  }

  private async failProposal(id: string, error: string, decision: unknown): Promise<void> {
    const row = this.proposal(id);
    const exhausted = (row?.attempts ?? 0) >= 3;
    await this.updateProposal(id, exhausted ? "rejected" : "pending", error, decision);
  }

  private prepareWrite(
    proposal: CuratorProposal,
    item: CuratorResultItem,
    judgement: CuratorJudgement,
    routedOperation: "create" | "update",
  ): PreparedSkillWrite {
    if (!item.skill || !Array.isArray(item.skill.files)) throw new Error("curator_skill_missing");
    const llmName = item.skill.name;
    const skillNames = this.skillBox.listSkills({ include_broken: true });
    const explicitTarget = proposal.payload.target ?? this.proposal(proposal.id)?.target_skill ?? null;
    const matched = selectSkillCandidates(proposal.payload, skillNames);
    const namedSkill = this.skillBox.getSkill(llmName);
    let target: SkillRecord | undefined;
    if (explicitTarget) target = this.skillBox.getSkill(explicitTarget);
    if (!target && (routedOperation === "update" || item.decision === "update" || item.decision === "merge")) {
      target = namedSkill ?? matched.map((skill) => this.skillBox.getSkill(skill.name)).find((skill) => skill !== undefined);
    }
    if ((routedOperation === "update" || item.decision === "update" || item.decision === "merge") && !target) {
      throw new Error("curator_update_target_missing");
    }
    const name = target?.name ?? llmName;
    if (!validateSkillName(name)) throw new Error("invalid_skill_name");
    if (!target && namedSkill) throw new Error(`skill_name_taken: a skill named ${name} already exists`);

    const description = item.skill.description.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").trim();
    if (description.length === 0 || description.length > 300) throw new Error("invalid_skill_description");
    const tags = item.skill.tags.map((tag) => tag.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").trim());
    if (tags.some((tag) => tag.length === 0)) throw new Error("invalid_skill_tags");

    const files: Record<string, string> = {};
    let totalBytes = 0;
    for (const file of item.skill.files) {
      if (!file || typeof file.path !== "string" || typeof file.content !== "string") throw new Error("curator_file_invalid");
      const validPath = validateSkillFilePath(file.path);
      if (!validPath.ok) throw new Error(validPath.reason);
      if (Object.prototype.hasOwnProperty.call(files, file.path)) throw new Error("curator_duplicate_file_path");
      if (file.content.includes("\0")) throw new Error("skill_file_contains_nul");
      const content = file.path === "SKILL.md" ? stripProvidedFrontmatter(file.content) : file.content;
      totalBytes += Buffer.byteLength(content, "utf8");
      if (totalBytes > 256 * 1024) throw new Error("skill_size_exceeds_256KB");
      files[file.path] = content;
    }
    if (!Object.prototype.hasOwnProperty.call(files, "SKILL.md")) throw new Error("curator_skill_md_missing");

    const scope = target?.scope ?? (proposal.project_id ? `project:${proposal.project_id}` : "global");
    const meta = { description, tags, scope };
    files["SKILL.md"] = renderSkillMd({ name, ...meta }, files["SKILL.md"]);
    totalBytes = Object.values(files).reduce((sum, content) => sum + Buffer.byteLength(content, "utf8"), 0);
    if (totalBytes > 256 * 1024) throw new Error("skill_size_exceeds_256KB");

    const archive = [...new Set(item.archive)];
    for (const archiveName of archive) {
      if (!validateSkillName(archiveName) || !this.skillBox.getSkill(archiveName)) throw new Error("curator_archive_skill_missing");
      if (archiveName === name) throw new Error("curator_archive_target_conflict");
    }
    const action = item.decision === "merge" ? "merge" : target ? "update" : "create";
    const row = this.proposal(proposal.id);
    if (!row) throw new Error("skill_proposal_not_found");
    if (target && judgement.relation === "same") {
      const previous = this.currentFiles(target.name, target.current_revision);
      if (previous && target.description === description && JSON.stringify(target.tags) === JSON.stringify(tags) && hashSkillFiles(previous) === hashSkillFiles(files)) {
        throw new Error("proposal_no_improvement");
      }
    }
    return {
      proposal_id: proposal.id,
      target_name: name,
      target_revision: target?.current_revision ?? null,
      files,
      meta,
      action,
      archive,
      reason: item.reason,
      source_proposal_id: proposal.id,
      source_work_id: row.source_work_id,
      source_agent_run_id: row.source_agent_run_id,
      project_id: proposal.project_id,
      relation: judgement.relation,
      judgement,
    };
  }

  private hasChangedScriptFiles(prepared: PreparedSkillWrite): boolean {
    const skill = this.skillBox.getSkill(prepared.target_name);
    const previous = skill ? this.currentFiles(skill.name, skill.current_revision) ?? {} : {};
    const paths = new Set([
      ...Object.keys(previous).filter((path) => path.startsWith("scripts/")),
      ...Object.keys(prepared.files).filter((path) => path.startsWith("scripts/")),
    ]);
    for (const path of paths) if (previous[path] !== prepared.files[path]) return true;
    return false;
  }

  private async applyPreparedWrite(prepared: PreparedSkillWrite): Promise<void> {
    let effective = prepared;
    const beforePromotion = this.skillBox.getSkill(prepared.target_name);
    const currentRevision = beforePromotion?.current_revision ?? null;
    if (currentRevision !== prepared.target_revision) {
      throw new Error(prepared.target_revision === null
        ? `skill_name_taken: a skill named ${prepared.target_name} already exists`
        : `skill_changed_since_proposal: ${prepared.target_name} is at revision ${currentRevision ?? "none"}, the proposal was written against revision ${prepared.target_revision}`);
    }
    if (
      beforePromotion?.scope.startsWith("project:")
      && beforePromotion.project_id !== prepared.project_id
      && (prepared.relation === "same" || prepared.relation === "extends")
    ) {
      await this.skillBox.setScope(prepared.target_name, "global", "curator", "The same procedure was independently proposed from another project.");
      const skillMd = parseSkillMd(prepared.files["SKILL.md"] ?? "");
      if ("error" in skillMd) throw new Error("skill_metadata_invalid");
      const meta = { ...prepared.meta, scope: "global" };
      const files = { ...prepared.files, "SKILL.md": renderSkillMd({ name: prepared.target_name, ...meta }, skillMd.body) };
      effective = { ...prepared, files, meta };
    }
    const applied = await this.skillBox.applyRevision({
      name: effective.target_name,
      files: effective.files,
      meta: effective.meta,
      actor: "curator",
      action: effective.action,
      reason: effective.reason,
      trial: true,
      source_proposal_id: effective.source_proposal_id,
      source_work_id: effective.source_work_id ?? undefined,
      source_agent_run_id: effective.source_agent_run_id ?? undefined,
    });
    for (const name of effective.archive) {
      const archived = this.skillBox.getSkill(name);
      if (archived && archived.state !== "archived") await this.skillBox.setState(name, "archived", "curator", `Archived after merge into ${effective.target_name}.`);
    }
    await this.updateProposal(effective.proposal_id, "applied", null, effective, applied.revision_id);
  }

  private async writeApprovedProposal(row: SkillProposalRow, decision: Record<string, unknown>): Promise<void> {
    const runCurator = this.agentRunner.runCurator;
    if (typeof runCurator !== "function") throw new Error("curator_unavailable");
    const payload = parseProposal(row.payload_json);
    const judgement = normalizeJudgement(decision.judgement);
    if (!payload || !judgement) throw new Error("skill_proposal_decision_invalid");
    const allSkills = this.skillBox.listSkills({ include_broken: true });
    const matches = selectSkillCandidates(payload, allSkills);
    const proposal: CuratorProposal = { id: row.id, payload, project_id: row.project_id, candidate_skill_names: matches.map((skill) => skill.name) };
    const candidates: CuratorCandidate[] = matches.flatMap((skill) => {
      const files = this.currentFiles(skill.name, skill.current_revision);
      return files ? [{ name: skill.name, description: skill.description, files }] : [];
    });
    const model = this.getModelConfig?.();
    await this.beginAttempts([row.id], "awaiting_approval");
    const result = await this.callCurator(runCurator, {
      proposals: [proposal],
      skill_index: allSkills.map((skill) => ({ name: skill.name, description: skill.description })),
      candidates,
      usages: this.recentUsages(candidates.map((candidate) => candidate.name)),
      with_judgement: false,
      knowledge: await this.composeKnowledge?.([proposal]),
      ...(model ? { model: model.model, provider: model.provider, effort: model.effort } : {}),
    });
    if (result === null) throw new Error("curator_stopped");
    if (!result.ok) return this.failApproval(row.id, result.error, decision);
    const item = result.results.find((candidate) => candidate.proposal_id === row.id);
    if (!item) return this.failApproval(row.id, "curator_result_missing", decision);
    if (item.decision === "reject") {
      await this.updateProposal(row.id, "rejected", item.reason, { ...item, judgement });
      return;
    }
    try {
      const prepared = this.prepareWrite(proposal, item, judgement, routeJudgement(judgement, "autonomous", 0, payload.kind).operation);
      if (this.hasChangedScriptFiles(prepared)) {
        await this.updateProposal(row.id, "awaiting_approval", null, prepared);
      } else {
        await this.applyPreparedWrite(prepared);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason === "proposal_no_improvement") await this.updateProposal(row.id, "rejected", reason, { ...item, judgement });
      else await this.failApproval(row.id, reason, decision);
    }
  }

  /**
   * Resolves with null when the Curator is stopped before the provider call
   * returns, so shutdown never waits for an LLM response.
   */
  private async callCurator(
    runCurator: NonNullable<AgentRunner["runCurator"]>,
    request: CuratorRequest,
  ): Promise<CuratorRunResult | null> {
    if (this.stopped) return null;
    const call = runCurator.call(this.agentRunner, request);
    // Why not log: `call` is awaited through the race below, which surfaces its rejection; this only avoids an unhandled rejection after stop wins the race.
    call.catch(() => undefined);
    const result = await Promise.race([call, this.stopSignal.then(() => null)]);
    return this.stopped ? null : result;
  }

  /**
   * Records a failed approval. The proposal keeps its approval and its saved
   * decision so it can be approved again, until attempts run out.
   */
  private async failApproval(id: string, error: string, decision: unknown): Promise<never> {
    const row = this.proposal(id);
    const exhausted = (row?.attempts ?? 0) >= 3;
    await this.updateProposal(id, exhausted ? "rejected" : "awaiting_approval", error, decision);
    throw new Error(error);
  }

  private async updateProposal(id: string, status: "pending" | "awaiting_approval" | "applied" | "rejected", error: string | null, decision: unknown, appliedRevisionId?: string): Promise<void> {
    await this.writeLane.transact((transaction: CoreWriteLaneTransaction) => {
      transaction.run(
        `UPDATE skill_proposals SET status = ?, last_error = ?, decision_json = ?,
                applied_revision_id = COALESCE(?, applied_revision_id), updated_at = ? WHERE id = ?`,
        status,
        error,
        decision === null ? null : JSON.stringify(decision),
        appliedRevisionId ?? null,
        this.now(),
        id,
      );
    });
  }
}

function parseProposal(text: string): CuratorProposal["payload"] | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || (value.kind !== "new" && value.kind !== "update")) return null;
    if (typeof value.summary !== "string" || typeof value.steps_or_diff !== "string" || typeof value.evidence !== "string") return null;
    return {
      kind: value.kind,
      // Only an update names a skill to change; SkillBox stores target_skill the same way.
      target: value.kind === "update" && typeof value.target === "string" ? value.target : null,
      summary: value.summary,
      steps_or_diff: value.steps_or_diff,
      evidence: value.evidence,
    };
  } catch {
    return null;
  }
}

function judgementReason(judgement: CuratorJudgement, threshold: number): string {
  if (judgement.reusable < 1) return "The procedure is not reusable across multiple Works.";
  if (judgement.work_specific >= 0.5) return "The procedure depends too much on one Work, issue, or date.";
  if (judgement.confidence < threshold) return "The judgement did not meet the configured confidence threshold.";
  return "The proposal did not meet the curation criteria.";
}

function stripProvidedFrontmatter(content: string): string {
  if (!/^---\r?\n/u.test(content)) return content;
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u.exec(content);
  if (!match) throw new Error("curator_skill_md_frontmatter_invalid");
  return content.slice(match[0].length).replace(/^\r?\n/u, "");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isPreparedWrite(value: unknown): value is PreparedSkillWrite {
  if (!isRecord(value)) return false;
  if (typeof value.proposal_id !== "string" || typeof value.target_name !== "string" || !validateSkillName(value.target_name)) return false;
  if (value.target_revision !== null && !Number.isSafeInteger(value.target_revision)) return false;
  if (!isRecord(value.files) || !Object.values(value.files).every((content) => typeof content === "string")) return false;
  if (!isRecord(value.meta) || typeof value.meta.description !== "string" || !Array.isArray(value.meta.tags) || typeof value.meta.scope !== "string") return false;
  if (value.action !== "create" && value.action !== "update" && value.action !== "merge") return false;
  if (!Array.isArray(value.archive) || !value.archive.every((name) => typeof name === "string" && validateSkillName(name))) return false;
  if (typeof value.reason !== "string" || typeof value.source_proposal_id !== "string") return false;
  if (value.source_work_id !== null && typeof value.source_work_id !== "string") return false;
  if (value.source_agent_run_id !== null && typeof value.source_agent_run_id !== "string") return false;
  if (value.project_id !== null && typeof value.project_id !== "string") return false;
  return value.relation === "same" || value.relation === "extends" || value.relation === "different";
}

function parseSnapshot(text: string): Record<string, string> | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || !Object.values(value).every((content) => typeof content === "string")) return null;
    return value as Record<string, string>;
  } catch {
    return null;
  }
}

function positiveDays(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 3650 ? value : fallback;
}

function runKindPriority(kind: CuratorRunKind): number {
  return kind === "tick" ? 3 : kind === "lifecycle" ? 2 : 1;
}

function words(value: string): Set<string> {
  return new Set((value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length > 1));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decisionReason(json: string | null): string | null {
  if (!json) return null;
  try {
    const value: unknown = JSON.parse(json);
    return isRecord(value) && typeof value.reason === "string" ? value.reason : null;
  } catch {
    return null;
  }
}
