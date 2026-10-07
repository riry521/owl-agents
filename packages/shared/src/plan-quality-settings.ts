export const PLAN_QUALITY_SETTINGS_KEY = "plan_quality";

export const PLAN_QUALITY_CODES = [
  "acceptance_items_over", "acceptance_chars_over", "broad_scope", "components_over", "verification_missing",
  "criterion_verification_missing", "external_state_comparison", "necessity_missing", "heavy_check_unjustified", "criterion_field_missing",
] as const;
export type PlanQualityCode = typeof PLAN_QUALITY_CODES[number];

export interface PlanQualitySettings {
  readonly enabled: boolean;
  /** Times the Manager is asked to repair one plan or replan before it is accepted with warnings. */
  readonly max_repair_requests: number;
  readonly max_acceptance_items: number;
  readonly max_acceptance_chars: number;
  readonly max_components: number;
  /** Regular expression sources; each distinct match counts as one component. */
  readonly component_patterns: readonly string[];
  /** Words that make an acceptance wide-ranging unless a path, file name or identifier narrows it. */
  readonly broad_scope_keywords: readonly string[];
  /** Task types whose acceptance must say how the result is verified. */
  readonly verification_required_types: readonly string[];
  readonly verification_keywords: readonly string[];
  /** Regular expression sources (case-insensitive); one match inside a single criterion means it says how it is checked. */
  readonly criterion_verification_patterns: readonly string[];
  /** Regular expression sources for things that change outside the Task (production, running servers, other Works). */
  readonly external_state_patterns: readonly string[];
  /** Regular expression sources for before/after or unchanged wording. */
  readonly state_comparison_patterns: readonly string[];
  /** Regular expression sources; text matching one of these (a copy made inside the Task, or direct write-denial evidence) is ignored when looking for external state. */
  readonly external_state_exempt_patterns: readonly string[];
  /** Regular expression sources (case-insensitive); a criterion matching one is a heavy check and needs a weight_reason. */
  readonly heavy_check_patterns: readonly string[];
  /** Warning codes that are still rejected after the repair requests are used up. */
  readonly blocking_codes: readonly PlanQualityCode[];
}

export const DEFAULT_PLAN_QUALITY_SETTINGS: PlanQualitySettings = {
  enabled: true,
  max_repair_requests: 1,
  max_acceptance_items: 8,
  max_acceptance_chars: 1500,
  max_components: 3,
  component_patterns: ["packages/[^/\\s]+", "apps/[^/\\s]+"],
  broad_scope_keywords: ["all", "every", "entire", "whole", "everywhere", "全て", "すべて", "全体", "全部"],
  verification_required_types: ["code", "config", "test"],
  verification_keywords: ["test", "verify", "verification", "build", "lint", "typecheck", "check", "assert", "テスト", "検証", "確認", "ビルド"],
  criterion_verification_patterns: ["\\b(npm|pnpm|yarn|node|npx|make|pytest|go test|cargo test)\\b", "\\.test\\.(mjs|ts|js)\\b", "確かめ方|確認方法|で確認|で検証", "\\b(verified by|checked by|run)\\b"],
  external_state_patterns: ["本番", "稼働中", "\\bproduction\\b", "\\blive (server|data|database)\\b", "\\brunning (server|instance)\\b", "他の\\s*Work", "\\bother Works?\\b"],
  state_comparison_patterns: ["前後", "変わらない", "変化しない", "変更されない", "不変", "\\bunchanged\\b", "\\bbefore and after\\b", "\\bremains? the same\\b", "\\bnot (changed|modified)\\b"],
  external_state_exempt_patterns: ["(本番|production|data/?|データ|DB|環境)[^。.\\n]{0,8}(の)?(コピー|複製|\\bcopy\\b)", "(コピー|複製|\\bcopy\\b)(した|を|上の|先の|of)?\\s*(本番|production|data/?|データ|DB|環境)", "一時(ディレクトリ|dir)", "\\btemp(orary)? (dir|directory|data|copy)", "書き込み(が|を)?拒否(された)?(ログ|証拠)?", "write[- ]denied( logs?)?", "denied writes?( logs?)?"],
  heavy_check_patterns: [
    "全件", "\\bfull (corpus|dataset|data ?set)\\b",
    "実モデル", "本物の(モデル|API|プロバイダ)", "\\breal (models?|providers?|LLMs?|APIs?)\\b", "OWL_PROVIDER=real",
    "\\d{3,}\\s*件", "\\b\\d{3,}\\s*(cases|items|records|files|entries)\\b",
    "\\d{2,}\\s*分", "\\d+\\s*時間", "\\b\\d{2,}\\s*min(ute)?s?\\b", "\\b\\d+\\s*hours?\\b",
    "(本番|production)[^。.\\n]{0,12}(コピー|複製|\\bcopy\\b|\\bsnapshot\\b)",
  ],
  blocking_codes: ["external_state_comparison", "criterion_field_missing", "heavy_check_unjustified"],
};

export class PlanQualitySettingsValidationError extends Error {
  public constructor(message: string, public readonly field: string) {
    super(message);
    this.name = "PlanQualitySettingsValidationError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown, min: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= min;
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
const isRegexSources = (value: unknown, flags = "g"): value is string[] => {
  if (!isStrings(value)) return false;
  try {
    for (const source of value) new RegExp(source, flags);
    return true;
  } catch {
    return false;
  }
};

const FIELD_CHECKS: Record<keyof PlanQualitySettings, (value: unknown) => boolean> = {
  enabled: (value) => typeof value === "boolean",
  max_repair_requests: (value) => isCount(value, 0),
  max_acceptance_items: (value) => isCount(value, 1),
  max_acceptance_chars: (value) => isCount(value, 1),
  max_components: (value) => isCount(value, 1),
  component_patterns: isRegexSources,
  broad_scope_keywords: isStrings,
  verification_required_types: isStrings,
  verification_keywords: isStrings,
  criterion_verification_patterns: (value) => isRegexSources(value, "iu"),
  external_state_patterns: (value) => isRegexSources(value, "iu"),
  state_comparison_patterns: (value) => isRegexSources(value, "iu"),
  external_state_exempt_patterns: (value) => isRegexSources(value, "iu"),
  heavy_check_patterns: (value) => isRegexSources(value, "iu"),
  blocking_codes: (value) => Array.isArray(value) && new Set(value).size === value.length
    && value.every((code) => (PLAN_QUALITY_CODES as readonly unknown[]).includes(code)),
};

/** For PUT: exact keys, each value valid. */
export function validatePlanQualitySettings(value: unknown): PlanQualitySettings {
  if (!isRecord(value)) throw new PlanQualitySettingsValidationError("Settings must be an object.", "payload");
  const keys = Reflect.ownKeys(value);
  const expected = Object.keys(FIELD_CHECKS);
  if (keys.length !== expected.length || !expected.every((key) => keys.includes(key))) {
    throw new PlanQualitySettingsValidationError(`Settings must contain exactly ${expected.join(", ")}.`, "payload");
  }
  for (const [field, check] of Object.entries(FIELD_CHECKS)) {
    if (!check(value[field])) throw new PlanQualitySettingsValidationError(`${field} is invalid.`, field);
  }
  return { ...(value as unknown as PlanQualitySettings) };
}

/** For reads: invalid or missing keys fall back to the defaults, per key, and call warn. */
export function readPlanQualitySettings(value: unknown, warn?: (message: string) => void): PlanQualitySettings {
  const stored = isRecord(value) ? value : {};
  const result: Record<string, unknown> = { ...DEFAULT_PLAN_QUALITY_SETTINGS };
  for (const [field, check] of Object.entries(FIELD_CHECKS)) {
    if (stored[field] === undefined) continue;
    if (check(stored[field])) result[field] = stored[field];
    else warn?.(`Invalid plan quality ${field}; using default.`);
  }
  return result as unknown as PlanQualitySettings;
}
