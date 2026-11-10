import { renderAcceptanceCriteria, type AcceptanceCriterion, type StoredAcceptanceCriterion } from "./acceptance-criteria.js";

/** Phrases (RegExp sources, case-insensitive) that make a criterion ask for the whole test suite. Callers may pass their own list. */
export const DEFAULT_FULL_TEST_PATTERNS: readonly string[] = [
  "(全て?|すべて|全部|全件)の?テスト",
  "既存の?テスト(スイート)?(が|は|を)?(すべて|全て|全件|全部)",
  "テスト(スイート)?全(体|件)",
  "全件の?(実行結果|実行)",
  "\\b(whole|full|entire|complete)\\s+(test\\s+)?suite\\b",
  "\\ball\\s+(the\\s+|existing\\s+)?tests\\b",
];

/** Criterion that keeps a Task valid when every criterion asked for the whole suite. */
export const DEFAULT_FULL_TEST_REPLACEMENT = {
  text: "この Task の変更が目的どおり入っていること（広い範囲の確認は Work の最後に Core が行う）",
  check: "変更したファイルを読んで確かめる（テストの全体実行はしない）",
  serves: "この Task の目的",
  if_omitted: "この Task の変更が目的を満たすか確かめられない",
} as const;

/**
 * Phrases (RegExp sources, case-insensitive) that limit "all tests" to a part of the project: a path with a slash
 * (tests/plan/, packages/core), a test file name, or a named package, module or directory ("the core package",
 * "core パッケージ"). A criterion naming one of them asks for that part, not the whole suite.
 */
export const DEFAULT_SCOPED_TEST_PATTERNS: readonly string[] = [
  "[\\w@.-]+/[\\w./-]*",
  "[\\w-]+\\.(test|spec)\\.[cm]?[jt]sx?\\b",
  "\\b(?!(tests?|the|each|every|all|any|whole|entire)\\b)[\\w@-]+\\s+(package|module|directory|folder|workspace)s?\\b",
  "[\\w@-]+\\s*(パッケージ|ディレクトリ|フォルダ|モジュール)",
];

/**
 * Judged on the criterion as a whole, with the text naming what is checked: a scope in the text keeps the criterion
 * even when its check reads "全件の実行結果を確認する" (the whole run of that scope). The check decides only when the
 * text names neither a scope nor the whole suite. Not "a scope in either field keeps it": a whole-suite text with
 * a check of one file would then stay, and the Worker would still run everything.
 */
export function isFullTestCriterion(
  criterion: Pick<AcceptanceCriterion, "text" | "check">,
  patterns: readonly string[] = DEFAULT_FULL_TEST_PATTERNS,
  scopedPatterns: readonly string[] = DEFAULT_SCOPED_TEST_PATTERNS,
): boolean {
  const has = (sources: readonly string[], field: string): boolean => sources.some((source) => new RegExp(source, "i").test(field));
  if (has(scopedPatterns, criterion.text)) return false;
  if (has(patterns, criterion.text)) return true;
  return has(patterns, criterion.check) && !has(scopedPatterns, criterion.check);
}

/**
 * Drops the criteria that ask for the whole test suite and renumbers the rest (AC1, AC2, ...).
 * When none would remain, one replacement criterion stays: the Manager schema and the Task
 * verification need at least one, and rejecting the plan would only make the Manager rewrite
 * a criterion Core removes anyway.
 */
export function stripFullTestCriteria<T extends StoredAcceptanceCriterion>(
  criteria: readonly T[],
  patterns: readonly string[] = DEFAULT_FULL_TEST_PATTERNS,
  replacement: Pick<AcceptanceCriterion, "text" | "check" | "serves" | "if_omitted"> = DEFAULT_FULL_TEST_REPLACEMENT,
  scopedPatterns: readonly string[] = DEFAULT_SCOPED_TEST_PATTERNS,
): { readonly criteria: readonly (T | AcceptanceCriterion)[]; readonly acceptance: string; readonly removed: number } {
  const kept = criteria.filter((criterion) => !isFullTestCriterion(criterion, patterns, scopedPatterns));
  const removed = criteria.length - kept.length;
  // Rendering reads only id, text, check and requirement, which a stored criterion has as well.
  const render = (list: readonly (T | AcceptanceCriterion)[]): string => renderAcceptanceCriteria(list as readonly AcceptanceCriterion[]);
  if (removed === 0) return { criteria, acceptance: render(criteria), removed };
  const base: readonly (T | AcceptanceCriterion)[] = kept.length > 0 ? kept : [{
    ...replacement,
    id: "",
    check_weight: "light",
    weight_reason: "",
    kind: "work_check",
    requirement: "required",
    origin: { kind: "manager", source: null, quote: "" },
  }];
  const numbered = base.map((criterion, index) => ({ ...criterion, id: `AC${index + 1}` }));
  return { criteria: numbered, acceptance: render(numbered), removed };
}
