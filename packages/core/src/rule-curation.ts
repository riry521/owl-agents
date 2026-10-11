import { fingerprint } from "./learning-fingerprint.js";
import type { PromptRule, RuleSet } from "./rule-store.js";
import type { RuleProposalRecord } from "./rule-proposals.js";
import type { RulePairJudge } from "./rule-judge.js";

export type RuleCurationVerdict =
  | "approve_candidate" | "duplicate_of_rule" | "near_duplicate_of_rule" | "possible_conflict"
  | "duplicate_of_proposal" | "invalid" | "awaiting_sources";

export interface RuleCurationRelated {
  readonly rule_id?: string;
  readonly proposal_id?: string;
  readonly path?: string;
  readonly text: string;
  readonly similarity: number;
}

export interface RuleCurationProposal {
  readonly id: string;
  readonly status: "pending" | "awaiting_approval";
  readonly text: string;
  readonly level: "system" | "role";
  readonly role: string | null;
  readonly verdict: RuleCurationVerdict;
  readonly related: RuleCurationRelated[];
  readonly note: string;
}

export interface RuleCurationFinding {
  readonly kind: "duplicate" | "near_duplicate" | "possible_conflict";
  readonly rules: Array<{ id: string; path: string | null; text: string }>;
  readonly similarity: number;
  readonly note: string;
}

export interface RuleCurationResult {
  readonly target: { open_proposals: number; rules: number };
  readonly proposals: RuleCurationProposal[];
  readonly awaiting_approval: Array<{ id: string; text: string; verdict: RuleCurationVerdict }>;
  readonly rule_findings: RuleCurationFinding[];
  readonly warnings: string[];
}

/** Threshold of the create-time fold of a new proposal into an open one (rule-proposals.ts); curation itself asks the model. */
export const NEAR_DUPLICATE = 0.8;

/** True when one rule can apply to the same role as the other (absolute and system rules apply to every role). */
export function coApply(a: { level: string; role?: string | null }, b: { level: string; role?: string | null }): boolean {
  return a.level !== "role" || b.level !== "role" || (a.role ?? null) === (b.role ?? null);
}

/**
 * Read-only judgement of open rule proposals against the current rules.
 * Meaning comes from `judge`; without it only exact (fingerprint) matches are reported.
 */
export async function curateRuleProposals(input: {
  readonly proposals: readonly RuleProposalRecord[];
  readonly rules: Pick<RuleSet, "promptRules"> & Partial<Pick<RuleSet, "files">>;
  readonly judge?: RulePairJudge;
}): Promise<RuleCurationResult> {
  const judge = input.judge;
  const open = input.proposals
    .filter((p): p is RuleProposalRecord & { status: "pending" | "awaiting_approval" } => p.status === "pending" || p.status === "awaiting_approval")
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const warnings: string[] = [];
  const pathById = new Map<string, string>();
  for (const file of input.rules.files ?? []) for (const rule of file.rules) pathById.set(rule.id, file.path);
  const pathOf = (rule: PromptRule): string | null => pathById.get(rule.id) ?? null;

  const isValid = (p: RuleProposalRecord): boolean => [...p.text].length >= 1 && [...p.text].length <= 300 && !/[\r\n]/u.test(p.text);
  const candidate = (a: string, b: string): boolean => fingerprint(a) !== fingerprint(b) && judge !== undefined && judge.isCandidate(a, b);
  const toJudge: Array<readonly [string, string]> = [];
  for (const proposal of open.filter(isValid)) {
    for (const rule of input.rules.promptRules) if (coApply(rule, proposal) && candidate(proposal.text, rule.text)) toJudge.push([proposal.text, rule.text]);
  }
  const allRules = input.rules.promptRules;
  for (let i = 0; i < allRules.length; i += 1) {
    for (let j = i + 1; j < allRules.length; j += 1) {
      if (coApply(allRules[i] as PromptRule, allRules[j] as PromptRule) && candidate((allRules[i] as PromptRule).text, (allRules[j] as PromptRule).text)) {
        toJudge.push([(allRules[i] as PromptRule).text, (allRules[j] as PromptRule).text]);
      }
    }
  }
  await judge?.judge(toJudge);
  const relation = (a: string, b: string) => (candidate(a, b) ? judge?.get(a, b) ?? null : null);

  const seen = new Map<string, RuleProposalRecord>();
  const proposals = open.map((proposal): RuleCurationProposal => {
    const base = { id: proposal.id, status: proposal.status, text: proposal.text, level: proposal.level, role: proposal.role };
    const done = (verdict: RuleCurationVerdict, note: string, related: RuleCurationRelated[] = []): RuleCurationProposal =>
      ({ ...base, verdict, related, note });
    if (!isValid(proposal)) return done("invalid", "Text must be one line of 1-300 characters.");

    const fp = fingerprint(proposal.text);
    const scoped = input.rules.promptRules.filter((r) => coApply(r, proposal));
    const relate = (rule: PromptRule, similarity: number): RuleCurationRelated =>
      ({ rule_id: rule.id, ...(pathOf(rule) ? { path: pathOf(rule) as string } : {}), text: rule.text, similarity });

    const same = scoped.find((r) => fingerprint(r.text) === fp);
    if (same) return done("duplicate_of_rule", "An existing rule already says this.", [relate(same, 1)]);
    const judged = scoped.map((rule) => ({ rule, relation: relation(proposal.text, rule.text), similarity: dice(proposal.text, rule.text) }));
    const conflict = judged.filter((s) => s.relation === "conflict");
    if (conflict.length > 0) {
      return done("possible_conflict", "The model judged this to contradict an existing rule.", conflict.map((s) => relate(s.rule, s.similarity)));
    }
    const near = judged.filter((s) => s.relation === "same");
    if (near.length > 0) return done("near_duplicate_of_rule", "The model judged an existing rule to say the same thing.", near.map((s) => relate(s.rule, s.similarity)));
    const earlier = seen.get(`${proposal.level}\u0000${proposal.role ?? ""}\u0000${fp}`);
    if (earlier) return done("duplicate_of_proposal", "An older open proposal has the same text.", [{ proposal_id: earlier.id, text: earlier.text, similarity: 1 }]);
    seen.set(`${proposal.level}\u0000${proposal.role ?? ""}\u0000${fp}`, proposal);
    const decision = proposal.decision as { reason?: unknown } | null;
    if (proposal.status === "pending" && decision?.reason === "awaiting_sources") return done("awaiting_sources", "Waiting for more sources.");
    return done("approve_candidate", "No overlap found.");
  });

  const rules = input.rules.promptRules;
  const rule_findings: RuleCurationFinding[] = [];
  for (let i = 0; i < rules.length; i += 1) {
    for (let j = i + 1; j < rules.length; j += 1) {
      const a = rules[i] as PromptRule;
      const b = rules[j] as PromptRule;
      if (!coApply(a, b)) continue;
      const exact = fingerprint(a.text) === fingerprint(b.text);
      const judged = exact ? null : relation(a.text, b.text);
      const similarity = exact ? 1 : dice(a.text, b.text);
      const kind = exact ? "duplicate" : judged === "conflict" ? "possible_conflict" : judged === "same" ? "near_duplicate" : null;
      if (!kind) continue;
      rule_findings.push({
        kind,
        rules: [a, b].map((r) => ({ id: r.id, path: pathOf(r), text: r.text })),
        similarity,
        note: kind === "possible_conflict" ? "The model judged these rules to contradict each other." : "Rules overlap.",
      });
    }
  }

  return {
    target: { open_proposals: proposals.length, rules: input.rules.promptRules.length },
    proposals,
    awaiting_approval: proposals.filter((p) => p.status === "awaiting_approval").map((p) => ({ id: p.id, text: p.text, verdict: p.verdict })),
    rule_findings,
    warnings: [...warnings, ...(judge?.warnings ?? [])],
  };
}

function bigrams(text: string): Map<string, number> {
  const chars = [...text.toLowerCase().replace(/\s+/gu, "")];
  const map = new Map<string, number>();
  for (let i = 0; i < chars.length - 1; i += 1) {
    const gram = chars[i] + chars[i + 1];
    map.set(gram, (map.get(gram) ?? 0) + 1);
  }
  return map;
}

export function dice(left: string, right: string): number {
  const a = bigrams(left);
  const b = bigrams(right);
  let overlap = 0;
  let total = 0;
  for (const n of a.values()) total += n;
  for (const n of b.values()) total += n;
  for (const [gram, n] of a) overlap += Math.min(n, b.get(gram) ?? 0);
  return total === 0 ? 0 : (2 * overlap) / total;
}
