import type { ActorRole } from "./index.js";
import { validateRoleOutput, type RoleSchema } from "./role-schema.js";

/** What started an automatic Work: a failure notice, a scheduled check, or a GitHub Issue/PR comment. */
export const AUTO_WORK_SOURCES = ["failure_notice", "scheduled_check", "github"] as const;
export type AutoWorkSource = (typeof AUTO_WORK_SOURCES)[number];

/** Why a signal was kept or skipped. `judging` is the reservation made while the AI decides. */
export const AUTO_WORK_VERDICTS = [
  "judging", "created", "duplicate", "below_threshold", "daily_cap", "unauthorized", "no_rule", "disabled", "not_worth", "judge_failed",
] as const;
export type AutoWorkVerdict = (typeof AUTO_WORK_VERDICTS)[number];

export const AUTO_WORK_RULE_ACTIONS = ["draft", "start"] as const;
export const AUTO_WORK_RULE_SIZES = ["small", "normal", "large"] as const;
export const AUTO_WORK_GITHUB_WATCHES = ["issues", "issue_comments", "pr_comments"] as const;
export const AUTO_WORK_GITHUB_LISTS = ["issues", "comments"] as const;
export type AutoWorkGithubList = (typeof AUTO_WORK_GITHUB_LISTS)[number];

/** The common shape every trigger converts to before the judgment sees it. */
export interface AutoWorkSignal {
  readonly source: AutoWorkSource;
  readonly project_id: string;
  readonly kind: string;
  readonly title: string;
  readonly detail: string;
  /** `id` is used as is; `text` is normalized before it becomes the dedupe key. */
  readonly dedupe: { readonly kind: "id"; readonly value: string } | { readonly kind: "text"; readonly value: string };
  readonly occurred_at: string;
  readonly backlog_item_ids: readonly string[];
  readonly github: {
    readonly repo: string;
    readonly issue_number: number;
    readonly is_pull_request: boolean;
    readonly comment_id: string | null;
    readonly author: string;
    readonly author_is_bot: boolean;
    readonly labels: readonly string[];
    readonly url: string;
    readonly updated_at: string;
  } | null;
  readonly failure: {
    readonly exit_code: number | null;
    readonly command: string | null;
    readonly log_path: string | null;
  } | null;
}

export interface GhRunOptions {
  readonly timeoutMs: number;
  /** stdout beyond this many bytes is cut and reported as `stdout_truncated`. */
  readonly outputLimitBytes: number;
  /** Written to stdin. Omitted: stdin is closed. */
  readonly stdin?: string;
}
export interface GhRunResult {
  readonly exit_code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timed_out: boolean;
  /** stdout was cut at the output limit, so it must not be read as JSON. */
  readonly stdout_truncated: boolean;
}
export type GhRunner = (args: readonly string[], options: GhRunOptions) => Promise<GhRunResult>;

/** Last fetch time of one GitHub list of one Project. */
export interface GithubListCursor {
  readonly since: string;
  readonly last_polled_at: string | null;
  readonly last_completed_at: string | null;
  readonly last_error: string | null;
}

export interface AutoWorkRule {
  readonly id: string;
  readonly source: AutoWorkSource;
  /** Empty: every kind of the source. */
  readonly kinds: readonly string[];
  readonly min_occurrences: number;
  /** 0: occurrences are not counted. */
  readonly window_minutes: number;
  readonly action: (typeof AUTO_WORK_RULE_ACTIONS)[number];
  readonly size: (typeof AUTO_WORK_RULE_SIZES)[number];
  readonly intent: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly disabled: boolean;
}

export interface AutoWorkWatchLog { readonly path: string; readonly pattern: string; readonly kind: string }
export interface AutoWorkWatchCommand { readonly argv: readonly string[]; readonly interval_minutes: number; readonly kind: string; readonly cwd?: string }

export interface AutoWorkGithubComments {
  readonly created: string;
  readonly completed: string;
  readonly completed_no_pr: string;
  readonly cancelled: string;
}

export interface AutoWorkGithubConfig {
  readonly repo: string | null;
  readonly poll_minutes: number;
  readonly per_page: number;
  readonly max_items_per_poll: number;
  /** How far before the previous fetch time the next fetch starts. */
  readonly since_margin_seconds: number;
  readonly max_item_attempts: number;
  readonly output_limit_bytes: number;
  readonly initial_lookback_hours: number;
  readonly timeout_seconds: number;
  readonly allowed_users: readonly string[];
  readonly require_labels: readonly string[];
  readonly watch: readonly (typeof AUTO_WORK_GITHUB_WATCHES[number])[];
  readonly mention: string;
  readonly owl_url: string | null;
  readonly comments: AutoWorkGithubComments;
}

/** The keys that only defaults.json and local.json decide; projects/<id>.json may not set them. */
export interface AutoWorkGlobalLimits {
  readonly max_works_per_day_all: number;
  readonly day_start_time: string;
  readonly alert_cooldown_minutes: number;
}

/** One configuration file's content after validation. defaults.json holds every key; the other layers hold a subset. */
export interface AutoWorkConfigFile {
  readonly schema_version?: 1;
  readonly enabled?: boolean;
  readonly judge_role?: ActorRole;
  readonly judge_timeout_seconds?: number;
  readonly candidate_limit?: number;
  readonly max_detail_chars?: number;
  readonly limits?: Partial<AutoWorkGlobalLimits & { max_works_per_day: number; cooldown_hours: number }>;
  readonly scheduled_check?: { readonly times?: readonly string[]; readonly items?: readonly string[] };
  readonly watch?: {
    readonly poll_seconds?: number;
    readonly context_lines?: number;
    readonly command_timeout_seconds?: number;
    readonly logs?: readonly AutoWorkWatchLog[];
    readonly commands?: readonly AutoWorkWatchCommand[];
  };
  readonly github?: Partial<Omit<AutoWorkGithubConfig, "comments">> & { readonly comments?: Partial<AutoWorkGithubComments> };
  readonly rules?: readonly (Partial<Omit<AutoWorkRule, "id">> & { readonly id: string })[];
}

export type AutoWorkRuleOrigin = "defaults" | "local" | "project";
export type AutoWorkEnabledFrom = "db" | "project_file" | "local_file" | "defaults";

export interface EffectiveAutoWorkRule extends AutoWorkRule {
  /** The layer that first defined the rule. */
  readonly origin: AutoWorkRuleOrigin;
  /** Field names a higher layer than `origin` changed. */
  readonly overridden_fields: readonly string[];
}

/** The settings of one Project after layering defaults.json, local.json, projects/<id>.json and the DB toggle. */
export interface EffectiveAutoWorkConfig {
  /** This Project's switch. */
  readonly enabled: { readonly effective: boolean; readonly from: AutoWorkEnabledFrom };
  /** The global switch. */
  readonly global_enabled: { readonly effective: boolean; readonly from: Exclude<AutoWorkEnabledFrom, "project_file"> };
  readonly judge_role: ActorRole;
  readonly judge_timeout_seconds: number;
  readonly candidate_limit: number;
  readonly max_detail_chars: number;
  readonly limits: AutoWorkGlobalLimits & { readonly max_works_per_day: number; readonly cooldown_hours: number };
  readonly scheduled_check: { readonly times: readonly string[]; readonly items: readonly string[] };
  readonly watch: {
    readonly poll_seconds: number;
    readonly context_lines: number;
    readonly command_timeout_seconds: number;
    readonly logs: readonly AutoWorkWatchLog[];
    readonly commands: readonly AutoWorkWatchCommand[];
  };
  readonly github: AutoWorkGithubConfig;
  readonly rules: readonly EffectiveAutoWorkRule[];
  /** Why a configuration file was not applied; null when every file was read. */
  readonly config_error: string | null;
}

/** The DB switches (settings key `auto_work`); null follows the files. */
export interface AutoWorkDbToggle {
  readonly global: boolean | null;
  readonly project: boolean | null;
}

/** Value of the settings key `auto_work`. */
export interface AutoWorkSettingsValue {
  readonly schema_version: "1.0.0";
  readonly version: number;
  readonly enabled: boolean | null;
  readonly projects: Readonly<Record<string, { readonly enabled: boolean | null }>>;
}

export function autoWorkDbToggle(settings: AutoWorkSettingsValue | null | undefined, projectId: string): AutoWorkDbToggle {
  return { global: settings?.enabled ?? null, project: settings?.projects?.[projectId]?.enabled ?? null };
}

export const AUTO_WORK_JUDGMENT_UNAVAILABLE = "auto_work_judgment_unavailable";
/** Upper bounds of the judgment's text fields; a longer value is a malformed answer. */
export const AUTO_WORK_REASON_MAX_CHARS = 500;
export const AUTO_WORK_TITLE_MAX_CHARS = 500;
export const AUTO_WORK_SUMMARY_MAX_CHARS = 20000;

export interface AutoWorkJudgmentRequest {
  readonly invocation_id?: string;
  readonly language: "ja" | "en";
  readonly model: { readonly provider: string; readonly model: string; readonly effort: string };
  readonly timeout_ms: number;
  readonly project: { readonly name: string; readonly overview: string | null };
  readonly rule: { readonly id: string; readonly intent: string; readonly action: (typeof AUTO_WORK_RULE_ACTIONS)[number]; readonly default_size: (typeof AUTO_WORK_RULE_SIZES)[number] };
  readonly signal: { readonly source: AutoWorkSource; readonly kind: string; readonly title: string; readonly detail: string; readonly occurred_at: string; readonly github_url: string | null };
  /** Works the signal may repeat: memo, ready, running, paused or judgement_waiting. */
  readonly open_works: readonly { readonly work_id: string; readonly display_number: number | null; readonly title: string; readonly summary_head: string; readonly state: string; readonly auto_created: boolean }[];
  /** Works this feature made lately, finished ones included. */
  readonly recent_auto_works: readonly { readonly work_id: string; readonly title: string; readonly verdict: "created"; readonly created_at: string; readonly work_state: string }[];
}

export interface AutoWorkJudgment {
  readonly worth_fixing: boolean;
  readonly reason: string;
  readonly duplicate_of_work_id: string | null;
  readonly duplicate_reason: string | null;
  readonly work: { readonly title: string; readonly summary: string; readonly size: (typeof AUTO_WORK_RULE_SIZES)[number] } | null;
}

export type AutoWorkJudgmentRunResult =
  | { readonly ok: true; readonly judgment: unknown }
  | { readonly ok: false; readonly error: string };

export const AUTO_WORK_JUDGMENT_SCHEMA: RoleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["worth_fixing", "reason", "duplicate_of_work_id", "duplicate_reason", "work"],
  properties: {
    worth_fixing: { type: "boolean", description: "true when the signal is worth a Work of its own" },
    reason: { type: "string", minLength: 1, description: "1-500 characters on why; shown in the history as the reason" },
    duplicate_of_work_id: { type: ["string", "null"], description: "work_id from open_works or recent_auto_works with the same cause; otherwise null" },
    duplicate_reason: { type: ["string", "null"], description: "1-500 characters on why it is the same cause; null without duplicate_of_work_id" },
    work: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["title", "summary", "size"],
      properties: {
        title: { type: "string", minLength: 1, description: "title of the Work, 1-500 characters" },
        summary: { type: "string", minLength: 1, description: "what to investigate and fix, written for the Manager" },
        size: { type: "string", enum: [...AUTO_WORK_RULE_SIZES], description: "small, normal or large" },
      },
      description: "required when worth_fixing is true and duplicate_of_work_id is null; otherwise null",
    },
  },
};

/** Never throws: the schema, the text lengths, then the ids against the Works that were offered. */
export function readAutoWorkJudgment(
  value: unknown,
  knownWorkIds: readonly string[],
): { readonly ok: true; readonly value: AutoWorkJudgment } | { readonly ok: false; readonly problem: string } {
  const schemaProblem = validateRoleOutput(AUTO_WORK_JUDGMENT_SCHEMA, value);
  if (schemaProblem !== null) return { ok: false, problem: schemaProblem };
  const judgment = value as AutoWorkJudgment;
  if (judgment.reason.length > AUTO_WORK_REASON_MAX_CHARS) return { ok: false, problem: "reason is longer than 500 characters" };
  if (judgment.duplicate_of_work_id !== null) {
    if (!knownWorkIds.includes(judgment.duplicate_of_work_id)) return { ok: false, problem: `duplicate_of_work_id is not an offered Work: ${judgment.duplicate_of_work_id}` };
    if (judgment.duplicate_reason === null || judgment.duplicate_reason.length === 0) return { ok: false, problem: "duplicate_reason is required with duplicate_of_work_id" };
    if (judgment.duplicate_reason.length > AUTO_WORK_REASON_MAX_CHARS) return { ok: false, problem: "duplicate_reason is longer than 500 characters" };
  } else if (judgment.worth_fixing && judgment.work === null) {
    return { ok: false, problem: "work is required when worth_fixing is true and duplicate_of_work_id is null" };
  }
  if (judgment.work !== null) {
    if (judgment.work.title.length > AUTO_WORK_TITLE_MAX_CHARS) return { ok: false, problem: "work.title is longer than 500 characters" };
    if (judgment.work.summary.length > AUTO_WORK_SUMMARY_MAX_CHARS) return { ok: false, problem: "work.summary is longer than 20000 characters" };
  }
  return { ok: true, value: judgment };
}
