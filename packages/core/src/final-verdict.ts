import type { OwnerLanguage } from "./owner-language";

/**
 * The Final Manager's verdict, in the template its output schema fixes
 * (packages/agent-runtime/src/manager.ts MANAGER_FINALIZE_OUTPUT_SCHEMA):
 * every missing point says what, why and how to fix it, and every lesson
 * says what was learned, what it rests on and where it applies.
 */
export interface FinalMissingItem {
  readonly item: string;
  readonly reason: string;
  readonly fix: string;
}

export interface FinalLesson {
  readonly lesson: string;
  readonly basis: string;
  readonly applies_to: string;
  /** Legacy Manager output, kept for previously recorded verdicts. */
  readonly proposes_rule?: boolean;
  readonly kind?: FinalLessonKind;
  readonly topic?: string;
  readonly procedure?: string;
  readonly rule_text?: string;
  readonly rule_scope?: FinalLessonRuleScope;
  readonly keywords?: readonly string[];
}

export type FinalLessonKind = "procedure" | "fact" | "decision" | "pitfall" | "rule_candidate";
export type FinalLessonRuleScope = "all" | "manager" | "designer" | "worker" | "reviewer" | "advisor";

const FINAL_LESSON_KINDS: readonly FinalLessonKind[] = ["procedure", "fact", "decision", "pitfall", "rule_candidate"];
const FINAL_LESSON_RULE_SCOPES: readonly FinalLessonRuleScope[] = ["all", "manager", "designer", "worker", "reviewer", "advisor"];

export interface NormalizedLesson {
  readonly lesson: string;
  readonly basis: string;
  readonly applies_to: string;
  readonly kind: FinalLessonKind;
  readonly topic: string;
  readonly procedure: string;
  readonly rule_text: string;
  readonly rule_scope: FinalLessonRuleScope;
  /** Absent for lessons recorded before keyword tagging. */
  readonly keywords?: readonly string[];
}

export interface LessonBlock {
  readonly index: number;
  readonly text: string;
  readonly rationale: string;
  readonly applies_to: string;
  readonly scope: FinalLessonRuleScope | null;
}

export interface FinalManagerVerdict {
  readonly verdict: "complete" | "incomplete";
  readonly summary: string;
  readonly missing: readonly FinalMissingItem[];
  /** Backlog items the Manager judged not addressed; malformed entries are dropped. */
  readonly unaddressed_backlog_items: readonly { readonly item_id: string; readonly reason: string }[];
  readonly lessons: readonly FinalLesson[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStrings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === "string");
}

export function isFinalMissingItem(value: unknown): value is FinalMissingItem {
  return isRecord(value) && hasStrings(value, ["item", "reason", "fix"]);
}

export function isFinalLesson(value: unknown): value is FinalLesson {
  if (!isRecord(value) || !hasStrings(value, ["lesson", "basis", "applies_to"])) return false;
  if (value.keywords !== undefined && !(Array.isArray(value.keywords) && value.keywords.every((keyword) => typeof keyword === "string"))) return false;
  if (typeof value.proposes_rule === "boolean") return true;
  return (
    FINAL_LESSON_KINDS.includes(value.kind as FinalLessonKind) &&
    hasStrings(value, ["topic", "procedure", "rule_text"]) &&
    FINAL_LESSON_RULE_SCOPES.includes(value.rule_scope as FinalLessonRuleScope)
  );
}

/** Convert a new or legacy Manager lesson into the normalized lesson contract. */
export function normalizeLesson(lesson: FinalLesson): NormalizedLesson {
  if (
    FINAL_LESSON_KINDS.includes(lesson.kind as FinalLessonKind) &&
    typeof lesson.topic === "string" &&
    typeof lesson.procedure === "string" &&
    typeof lesson.rule_text === "string" &&
    FINAL_LESSON_RULE_SCOPES.includes(lesson.rule_scope as FinalLessonRuleScope)
  ) {
    return {
      lesson: lesson.lesson,
      basis: lesson.basis,
      applies_to: lesson.applies_to,
      kind: lesson.kind as FinalLessonKind,
      topic: lesson.topic,
      procedure: lesson.procedure,
      rule_text: lesson.rule_text,
      rule_scope: lesson.rule_scope as FinalLessonRuleScope,
      ...(lesson.keywords ? { keywords: lesson.keywords } : {}),
    };
  }
  const proposesRule = lesson.proposes_rule === true;
  return {
    lesson: lesson.lesson,
    basis: lesson.basis,
    applies_to: lesson.applies_to,
    kind: proposesRule ? "rule_candidate" : "fact",
    topic: "",
    procedure: "",
    rule_text: proposesRule ? lesson.lesson : "",
    rule_scope: "all",
    ...(lesson.keywords ? { keywords: lesson.keywords } : {}),
  };
}

const LABELS: Readonly<Record<OwnerLanguage, { reason: string; fix: string; basis: string; appliesTo: string; scope: string }>> = {
  ja: { reason: "理由", fix: "直し方", basis: "根拠", appliesTo: "当てはまる場面", scope: "適用範囲" },
  en: { reason: "Why", fix: "How to fix", basis: "Basis", appliesTo: "Applies to", scope: "Scope" },
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** A labelled block: the head line, then one indented `label: value` line per non-empty detail. */
function block(head: string, details: readonly (readonly [string, unknown])[], indent: string): string {
  const lines = details.flatMap(([label, value]) => (text(value) ? [`${indent}${label}: ${text(value)}`] : []));
  return [head, ...lines].join("\n");
}

/**
 * One missing point as a bullet with its reason and fix. A plain string is
 * accepted for events recorded before the template.
 */
export function formatMissingItem(value: unknown, language: OwnerLanguage): string | null {
  if (typeof value === "string") return text(value) ? `- ${text(value)}` : null;
  if (!isFinalMissingItem(value) || !text(value.item)) return null;
  const labels = LABELS[language];
  return block(`- ${text(value.item)}`, [[labels.reason, value.reason], [labels.fix, value.fix]], "  ");
}

/** One lesson as a bullet with its basis and scope (plain strings accepted for old data). */
export function formatLesson(value: unknown, language: OwnerLanguage): string | null {
  if (typeof value === "string") return text(value) ? `- ${text(value)}` : null;
  if (!isFinalLesson(value) || !text(value.lesson)) return null;
  const labels = LABELS[language];
  return block(`- ${text(value.lesson)}`, [[labels.basis, value.basis], [labels.appliesTo, value.applies_to]], "  ");
}

/** One rule candidate as a lesson block with an explicit migration scope. */
export function formatRuleCandidate(value: NormalizedLesson, language: OwnerLanguage): string | null {
  if (value.kind !== "rule_candidate" || !text(value.rule_text)) return null;
  const labels = LABELS[language];
  return block(
    `- ${text(value.rule_text)}`,
    [[labels.basis, value.basis], [labels.appliesTo, value.applies_to], [labels.scope, value.rule_scope]],
    "  ",
  );
}

/** Split formatted lesson text into bullet-led blocks, discarding blank lines. */
export function splitLessonBlocks(body: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) blocks.push(current.join("\n").trimEnd());
    current = [];
  };
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith("- ")) {
      flush();
      current.push(line);
    } else if (current.length > 0 && line.trim().length > 0) {
      current.push(line);
    }
  }
  flush();
  return blocks;
}

/** Parse localized and legacy lesson blocks into migration-ready fields. */
export function parseLessonBlocks(body: string): LessonBlock[] {
  return splitLessonBlocks(body).flatMap((blockText, blockIndex) => {
    const lines = blockText.split(/\r?\n/u);
    const head = lines[0] ?? "";
    const lessonText = head.startsWith("- ") ? head.slice(2).trim() : "";
    if (!lessonText) return [];

    let rationale = "";
    let appliesTo = "";
    let rawScope = "";
    let lastField: "rationale" | "applies_to" | "scope" = "rationale";
    const append = (current: string, value: string) => current ? `${current}\n${value}` : value;

    for (const line of lines.slice(1)) {
      const label = /^  (根拠|Basis|当てはまる場面|Applies to|適用範囲|Scope): (.*)$/u.exec(line);
      if (label) {
        const value = label[2].trim();
        switch (label[1]) {
          case "根拠":
          case "Basis":
            rationale = append(rationale, value);
            lastField = "rationale";
            break;
          case "当てはまる場面":
          case "Applies to":
            appliesTo = append(appliesTo, value);
            lastField = "applies_to";
            break;
          case "適用範囲":
          case "Scope":
            rawScope = append(rawScope, value);
            lastField = "scope";
            break;
        }
        continue;
      }

      const continuation = line.trim();
      if (!continuation) continue;
      if (lastField === "applies_to") appliesTo = append(appliesTo, continuation);
      else if (lastField === "scope") rawScope = append(rawScope, continuation);
      else rationale = append(rationale, continuation);
    }

    return [{
      index: blockIndex + 1,
      text: lessonText,
      rationale,
      applies_to: appliesTo,
      scope: FINAL_LESSON_RULE_SCOPES.includes(rawScope as FinalLessonRuleScope) ? rawScope as FinalLessonRuleScope : null,
    }];
  });
}

/** Key a lesson block by its head text and optional localized scope row. */
export function lessonBlockKey(blockText: string): string {
  const lines = blockText.split(/\r?\n/);
  const head = lines[0]?.startsWith("- ") ? lines[0].slice(2).trim() : "";
  const scopeLine = lines.find((line) => /^\s*(?:適用範囲|Scope):/.test(line));
  const scope = scopeLine?.replace(/^\s*(?:適用範囲|Scope):/, "").trim() ?? "";
  return `${head}\n${scope}`;
}

export function formatMissingList(values: unknown, language: OwnerLanguage): string | null {
  const blocks = Array.isArray(values) ? values.map((value) => formatMissingItem(value, language)).filter((value): value is string => value !== null) : [];
  return blocks.length > 0 ? blocks.join("\n") : null;
}

export function formatLessonList(values: unknown, language: OwnerLanguage): string | null {
  const blocks = Array.isArray(values) ? values.map((value) => formatLesson(value, language)).filter((value): value is string => value !== null) : [];
  return blocks.length > 0 ? blocks.join("\n") : null;
}
