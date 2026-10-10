import { findListKey, normalizeOp, type OpDefinitions } from "./op-shape.js";
import { dice } from "./rule-curation.js";

/** How two rule texts relate; "different" and an absent judgment both mean "do not treat as overlapping". */
export type RuleRelation = "same" | "conflict" | "different";

export interface RuleJudgeModel { readonly provider: string; readonly model: string; readonly effort: string }

export interface RuleJudgmentRequest {
  readonly model: RuleJudgeModel;
  readonly language: string;
  readonly pairs: Array<{ pair_id: string; left: string; right: string }>;
}
export type RuleJudgmentRunner = (request: RuleJudgmentRequest) => Promise<{ ok: true; output: unknown } | { ok: false; error: string }>;

export interface RulePairJudgeOptions {
  /** Undefined when the agent runner cannot judge; every pair is then left unjudged. */
  readonly runner: () => RuleJudgmentRunner | undefined;
  readonly model: () => RuleJudgeModel;
  readonly language: () => string;
  readonly batchSize?: number;
  readonly minDice?: number;
  readonly minSharedTokens?: number;
}

export const RULE_JUDGE_BATCH = 40;
// Why not the old 0.8: Japanese rewordings score 0.29-0.68. The cheap score only drops clearly unrelated pairs.
export const RULE_JUDGE_MIN_DICE = 0.2;
export const RULE_JUDGE_MIN_SHARED_TOKENS = 2;
const RELATIONS: readonly string[] = ["same", "conflict", "different"];
// Each relation is a definition so a wrapped judgment like {same:{pair_id}} reads the same as {pair_id, relation:"same"}.
const RELATION_DEFS: OpDefinitions = Object.fromEntries(RELATIONS.map((name) => [name, { required: { pair_id: "" } }]));

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9_~./-]{2,}/gu) ?? []);
}

const keyOf = (a: string, b: string): string => (a <= b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/** Judges rule text pairs with the model, at most once per pair for the life of the instance (one curation run). */
export class RulePairJudge {
  public readonly warnings: string[] = [];
  private readonly results = new Map<string, RuleRelation | null>();

  public constructor(private readonly options: RulePairJudgeOptions) {}

  /** Cheap pre-filter: pairs with little text overlap and few shared paths/commands never reach the model. */
  public isCandidate(a: string, b: string): boolean {
    if (dice(a, b) >= (this.options.minDice ?? RULE_JUDGE_MIN_DICE)) return true;
    const right = tokens(b);
    let shared = 0;
    for (const token of tokens(a)) if (right.has(token)) shared += 1;
    return shared >= (this.options.minSharedTokens ?? RULE_JUDGE_MIN_SHARED_TOKENS);
  }

  public get(a: string, b: string): RuleRelation | null {
    return this.results.get(keyOf(a, b)) ?? null;
  }

  public async judge(pairs: ReadonlyArray<readonly [string, string]>): Promise<void> {
    const fresh = new Map<string, readonly [string, string]>();
    for (const [a, b] of pairs) if (!this.results.has(keyOf(a, b))) fresh.set(keyOf(a, b), [a, b]);
    const todo = [...fresh.entries()];
    if (todo.length === 0) return;
    for (const [key] of todo) this.results.set(key, null);
    const run = this.options.runner();
    if (!run) { this.warn("Rule judgments are unavailable; nothing was merged by meaning."); return; }
    const size = Math.max(1, this.options.batchSize ?? RULE_JUDGE_BATCH);
    for (let i = 0; i < todo.length; i += size) {
      const batch = todo.slice(i, i + size);
      const pairsOut = batch.map(([, [left, right]], n) => ({ pair_id: `p${n}`, left, right }));
      let reply: Awaited<ReturnType<RuleJudgmentRunner>>;
      try {
        reply = await run({ model: this.options.model(), language: this.options.language(), pairs: pairsOut });
      } catch (error) {
        reply = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (!reply.ok) { this.warn(`Rule judgment failed: ${reply.error}`); continue; }
      const parsed = parseJudgments(reply.output);
      if (!parsed) { this.warn("Rule judgment output could not be read."); continue; }
      const answered = new Set<string>();
      for (const [pairId, relation] of parsed) {
        const index = pairsOut.findIndex((p) => p.pair_id === pairId);
        if (index < 0 || !relation) { this.warn("Rule judgment contained an unreadable item or an unknown pair_id; it was ignored."); continue; }
        this.results.set(batch[index][0], relation);
        answered.add(pairId);
      }
      if (answered.size < pairsOut.length) this.warn(`Rule judgment left ${pairsOut.length - answered.size} of ${pairsOut.length} pairs unjudged.`);
    }
  }

  private warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }
}

const lowerKeys = (item: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(item).map(([k, v]) => [k.trim().toLowerCase(), v]));

/** Reads `{judgments:[{pair_id, relation}]}` allowing a JSON string, a bare array, another array key, and key/value case or spacing drift. */
function parseJudgments(output: unknown): Array<[string, RuleRelation | null]> | null {
  let value = output;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  let list: unknown = value;
  if (!Array.isArray(value)) {
    if (typeof value !== "object" || value === null) return null;
    const lowered = lowerKeys(value);
    const key = findListKey(lowered, "judgments", []);
    if (key === null) return null;
    list = lowered[key];
  }
  if (!Array.isArray(list)) return null;
  return list.map((item): [string, RuleRelation | null] => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return ["", null];
    let fields = lowerKeys(item);
    if (typeof fields.relation !== "string") {
      const flat = normalizeOp(fields, RELATION_DEFS);
      if (flat) fields = { ...lowerKeys(flat), relation: flat.op };
    }
    const relation = typeof fields.relation === "string" ? fields.relation.trim().toLowerCase() : "";
    return [typeof fields.pair_id === "string" ? fields.pair_id.trim() : "", RELATIONS.includes(relation) ? relation as RuleRelation : null];
  });
}
