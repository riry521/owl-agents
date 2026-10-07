export const PROJECT_INVESTIGATION_OUTPUT_SETTINGS_KEY = "project_investigation_output";

export interface ProjectInvestigationOutputSettings {
  readonly max_chars: {
    readonly purpose: number;
    readonly architecture_flow: number;
    readonly entry_points: number;
    readonly run_and_test: number;
    readonly caution: number;
  };
  readonly max_cautions: number;
  readonly max_evidence_paths: number;
  /** Regular expression source (flags in PROJECT_INVESTIGATION_PATTERN_FLAGS); every text must match it (Japanese). */
  readonly required_pattern: string;
  /** Regular expression sources; a text must not match them. The caution_* ones apply to cautions only. */
  readonly forbidden_patterns: {
    readonly absolute_path: string;
    readonly secret_name: string;
    readonly secret_value: string;
    readonly caution_sensitive: string;
    readonly caution_transient: string;
  };
}

export const PROJECT_INVESTIGATION_PATTERN_FLAGS: Readonly<Record<string, string>> = {
  required_pattern: "u",
  absolute_path: "u",
  secret_name: "iu",
  secret_value: "u",
  caution_sensitive: "iu",
  caution_transient: "u",
};

export const DEFAULT_PROJECT_INVESTIGATION_OUTPUT_SETTINGS: ProjectInvestigationOutputSettings = {
  max_chars: { purpose: 120, architecture_flow: 200, entry_points: 200, run_and_test: 160, caution: 100 },
  max_cautions: 3,
  max_evidence_paths: 3,
  required_pattern: "[\\u3040-\\u30ff\\u4e00-\\u9fff]",
  forbidden_patterns: {
    absolute_path: "\\/(?:Users|home|etc|var|private)\\/|[A-Za-z]:\\\\|~\\/",
    secret_name: "\\.env|secrets?\\.json|\\.ssh|\\.aws|\\.config\\/gh|id_rsa|id_ed25519|id_ecdsa|\\.netrc|\\.npmrc|\\.pypirc|credentials",
    secret_value: "-----BEGIN|gh[pousr]_|github_pat_|\\bsk-|xox[abp]-|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{20,}",
    caution_sensitive: "secret|\\.env|auth\\.json|token|passw|api[ _-]?key|キー|トークン|パスワード|認証",
    caution_transient: "\\b(?:WARN|WARNING|ERROR|FATAL)\\b|\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}|案[A-Z]|選択肢|採用|(?:^|[\\s、])[A-Z]\\s*は|\\|.*\\|",
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;
const isRegexSource = (value: unknown, flags: string): value is string => {
  if (typeof value !== "string" || !value) return false;
  try {
    new RegExp(value, flags);
    return true;
  } catch {
    return false;
  }
};

/** Invalid or missing values fall back to the defaults, per key, and call warn. */
export function readProjectInvestigationOutputSettings(value: unknown, warn?: (message: string) => void): ProjectInvestigationOutputSettings {
  const stored = isRecord(value) ? value : {};
  const defaults = DEFAULT_PROJECT_INVESTIGATION_OUTPUT_SETTINGS;
  const pick = <T>(candidate: unknown, fallback: T, valid: (item: unknown) => boolean, name: string): T => {
    if (candidate === undefined) return fallback;
    if (valid(candidate)) return candidate as T;
    warn?.(`Invalid project investigation output ${name}; using default.`);
    return fallback;
  };
  const storedChars = isRecord(stored.max_chars) ? stored.max_chars : {};
  const storedPatterns = isRecord(stored.forbidden_patterns) ? stored.forbidden_patterns : {};
  const chars = Object.fromEntries(Object.entries(defaults.max_chars).map(([key, fallback]) => [key, pick(storedChars[key], fallback, isCount, `max_chars.${key}`)]));
  const patterns = Object.fromEntries(Object.entries(defaults.forbidden_patterns).map(([key, fallback]) => [
    key, pick(storedPatterns[key], fallback, (item) => isRegexSource(item, PROJECT_INVESTIGATION_PATTERN_FLAGS[key]), `forbidden_patterns.${key}`),
  ]));
  return {
    max_chars: chars as unknown as ProjectInvestigationOutputSettings["max_chars"],
    max_cautions: pick(stored.max_cautions, defaults.max_cautions, isCount, "max_cautions"),
    max_evidence_paths: pick(stored.max_evidence_paths, defaults.max_evidence_paths, isCount, "max_evidence_paths"),
    required_pattern: pick(stored.required_pattern, defaults.required_pattern, (item) => isRegexSource(item, PROJECT_INVESTIGATION_PATTERN_FLAGS.required_pattern), "required_pattern"),
    forbidden_patterns: patterns as unknown as ProjectInvestigationOutputSettings["forbidden_patterns"],
  };
}
