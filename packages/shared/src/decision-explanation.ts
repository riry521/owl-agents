import type { JsonObject } from "./index.js";
import { AUTO_RECOVERY_ACTIONS, AUTO_RECOVERY_KINDS, IMMEDIATE_DECISION_REASONS } from "./auto-recovery-names.js";
import { MANAGER_FINALIZE_OUTPUT_SCHEMA, MANAGER_FINALIZE_PAGES_OUTPUT_SCHEMA, MANAGER_PLAN_OUTPUT_SCHEMA, MANAGER_REPLAN_OUTPUT_SCHEMA } from "./manager-schema.js";
import { MANAGER_TRIGGER_KINDS, OWNER_REPLAN_KINDS, OWNER_REQUEST_SITUATIONS, PLAN_FEEDBACK_KINDS, TASK_INTEGRATION_FAILURE_KINDS, TASK_REPLAN_TRIGGER_KINDS } from "./manager-trigger.js";
import { validateRoleOutput, type RoleSchema } from "./role-schema.js";

/** work: the criteria are fine, the work is lacking / criteria: the criteria cannot be met inside the Task / external: the cause is outside the Task. */
export const DECISION_CAUSE_KINDS = ["work", "criteria", "external"] as const;
export type DecisionCauseKind = (typeof DECISION_CAUSE_KINDS)[number];
export const DECISION_EXPLANATION_KINDS = [
  "final_incomplete", "integration_failed", "final_failed", "merge_failed", "work_halted",
  "report_format", "review_format", "partial_limit", "review_budget", "task_failed",
  "test_environment", "remake_limit", "design_blocked", "no_progress",
  "prerequisite_wait", "work_prerequisite", "criteria_unverifiable", "replan_failed",
] as const;
export type DecisionExplanationKind = (typeof DECISION_EXPLANATION_KINDS)[number];

/**
 * Kinds whose explanation may add fix options; Core sends their instruction to the Manager.
 * Left out, because the Manager cannot fix them by replanning: report_format and review_format (the Worker's or
 * Reviewer's output format, rerun by the retry option), test_environment (the Owner's machine),
 * integration_failed, final_failed, merge_failed and work_halted (Core's own checks, merge or tick failed, not the plan),
 * design_blocked (a design stop already goes to the Manager whatever the answer), prerequisite_wait and
 * work_prerequisite (waiting on something outside the plan).
 */
export const DECISION_FIX_OPTION_KINDS: readonly DecisionExplanationKind[] = [
  "partial_limit", "final_incomplete", "review_budget", "task_failed", "remake_limit", "no_progress", "criteria_unverifiable", "replan_failed",
];

/** A kind that allows fix options needs at least one: a Decision with only retry and cancel does not fit the situation. */
export const DECISION_FIX_OPTIONS_MIN = 1;
export const DECISION_FIX_OPTION_PREFIX = "fix_";

export interface DecisionFixOptionReport {
  readonly label: string;
  readonly description: string;
  readonly instruction: string;
  readonly criteria_rewrites: readonly { readonly criterion_id: string; readonly after: string; readonly check: string }[];
}

/** What the model returns (before Core adds keys and the "before" texts). */
export interface DecisionExplanationReport {
  /** The neck: what keeps it from going on, in the Owner's words. */
  readonly summary: string;
  readonly cause_kind: DecisionCauseKind;
  /** What the Owner can do now, including that a word in the answer field is followed by the Manager. */
  readonly next_steps: string;
  /** One note per option the Decision already has, by key: what happens when the Owner picks it. */
  readonly option_notes: readonly { readonly key: string; readonly note: string }[];
  /** Fix options, each phrased as a question ending in "にしますか？": at least one for DECISION_FIX_OPTION_KINDS, [] for the others. */
  readonly options: readonly DecisionFixOptionReport[];
  /** One key: an option the Decision already has, or fix_1..fix_N for the fix options above. */
  readonly recommended_option_key: string;
}

export const DECISION_EXPLANATION_SCHEMA: RoleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "cause_kind", "next_steps", "option_notes", "options", "recommended_option_key"],
  properties: {
    summary: { type: "string", minLength: 1, description: "the neck: what keeps it from going on, in the Owner's words, without internal terms" },
    cause_kind: { type: "string", enum: [...DECISION_CAUSE_KINDS], description: "work, criteria or external" },
    next_steps: { type: "string", minLength: 1, description: "what the Owner can do now; a word in the answer field is followed by the Manager" },
    option_notes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "note"],
        properties: {
          key: { type: "string", minLength: 1, description: "key of an option the Decision already has" },
          note: { type: "string", minLength: 1, description: "what happens, from the Owner's side, when the Owner picks it" },
        },
      },
      description: "one note for every option the Decision already has",
    },
    options: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "description", "instruction", "criteria_rewrites"],
        properties: {
          label: { type: "string", minLength: 1, description: "the option as a question to the Owner, ending in にしますか？ (ja) or a question mark (en)" },
          description: { type: "string", minLength: 1, description: "what happens, from the Owner's side, when the Owner picks it" },
          instruction: { type: "string", minLength: 1, description: "what the Manager should do when the Owner picks it" },
          criteria_rewrites: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["criterion_id", "after", "check"],
              properties: {
                criterion_id: { type: "string", minLength: 1, description: "id of the acceptance criterion to reword" },
                after: { type: "string", minLength: 1, description: "the reworded criterion" },
                check: { type: "string", minLength: 1, description: "how to check the reworded criterion inside the Task" },
              },
            },
            description: "reworded criteria; [] unless the option rewrites criteria",
          },
        },
      },
      description: "ways to fix the stop; [] unless the kind allows fix options",
    },
    recommended_option_key: { type: "string", minLength: 1, description: "key of the one recommended option" },
  },
};

/** Words an Owner does not know; each Decision adds its own ids as forbidden terms. */
export const DECISION_INTERNAL_TERM_PATTERNS: readonly RegExp[] = [
  /\bpartial\b/i,
  /\bAC\s?\d+\b/i,
  /\b[0-9A-HJKMNP-TV-Z]{26}\b/,
  /\b(?:worktree|lineage)\b/i,
];

const SNAKE_CASE_NAME = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/** Owl's own snake_case names, collected from the schemas and kind lists they are defined in; none is written by hand here. */
const owlInternalNames = new Set<string>();

/** Every property key of a schema, at any depth. */
function collectSchemaKeys(schema: RoleSchema): string[] {
  return [
    ...Object.entries(schema.properties ?? {}).flatMap(([key, child]) => [key, ...collectSchemaKeys(child)]),
    ...(schema.items ? collectSchemaKeys(schema.items) : []),
  ];
}

const SNAKE_CASE_ONLY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u;

for (const name of [
  ...[DECISION_EXPLANATION_SCHEMA, MANAGER_PLAN_OUTPUT_SCHEMA, MANAGER_REPLAN_OUTPUT_SCHEMA, MANAGER_FINALIZE_OUTPUT_SCHEMA, MANAGER_FINALIZE_PAGES_OUTPUT_SCHEMA].flatMap(collectSchemaKeys),
  ...DECISION_EXPLANATION_KINDS,
  ...TASK_REPLAN_TRIGGER_KINDS,
  ...MANAGER_TRIGGER_KINDS,
  ...PLAN_FEEDBACK_KINDS,
  ...TASK_INTEGRATION_FAILURE_KINDS,
  ...OWNER_REPLAN_KINDS,
  ...OWNER_REQUEST_SITUATIONS,
  ...AUTO_RECOVERY_KINDS,
  ...AUTO_RECOVERY_ACTIONS,
  ...IMMEDIATE_DECISION_REASONS,
]) if (SNAKE_CASE_ONLY.test(name)) owlInternalNames.add(name);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** The matched words of text that an Owner should not see. A snake_case name inside backticks is the Owner's own and passes unless it is one of Owl's. */
export function findInternalTerms(text: string, forbiddenTerms: readonly string[]): string[] {
  const found: string[] = [];
  for (const pattern of DECISION_INTERNAL_TERM_PATTERNS) {
    const match = pattern.exec(text);
    if (match) found.push(match[0]);
  }
  const codeSpans = [...text.matchAll(/`[^`]*`/gu)].map((span) => [span.index, span.index + span[0].length] as const);
  for (const match of text.matchAll(SNAKE_CASE_NAME)) {
    const inCode = codeSpans.some(([start, end]) => match.index >= start && match.index < end);
    if (owlInternalNames.has(match[0]) || !inCode) found.push(match[0]);
  }
  for (const term of forbiddenTerms) {
    if (term === "") continue;
    const match = new RegExp(`(?<![\\w])${escapeRegExp(term)}(?![\\w])`, "u").exec(text);
    if (match) found.push(match[0]);
  }
  return found;
}

export interface DecisionExplanationCheckContext {
  readonly kind: DecisionExplanationKind;
  /** The options the Decision already has, in order; labels are Core's texts and only go into DecisionTexts. */
  readonly options: readonly { readonly key: string; readonly label: string }[];
  /** Core's own recommendation; non-null fixes the answer's recommended_option_key. */
  readonly recommended: string | null;
  readonly criterion_ids: readonly string[];
  readonly forbidden_terms: readonly string[];
}

/** A criterion rewrite as the text checks see it; criterion_id ties it back to the stored option and is never shown. */
export interface DecisionTextRewrite {
  readonly criterion_id: string;
  readonly after: string;
  readonly check: string;
}

/** The texts the Owner reads, as the text checks see them. */
export interface DecisionTexts {
  readonly summary: string;
  readonly next_steps: string;
  /** Every option in display order: fix options first, then the Decision's own. */
  readonly options: readonly {
    readonly key: string;
    /** true for the fix options the explanation wrote: their label is the model's text and may be fixed. false for the Decision's own options: their label is Core's and must stay. */
    readonly generated: boolean;
    readonly label: string;
    /** The fix option's description, or the option_notes entry of the Decision's own option. */
    readonly note: string;
    /** The fix option's criteria rewrites in order; [] for the Decision's own options. */
    readonly criteria_rewrites: readonly DecisionTextRewrite[];
  }[];
}

/** Collect the texts of a checked report; options gives the Decision's own options in order. */
export function decisionTextsOf(
  report: DecisionExplanationReport,
  options: readonly { readonly key: string; readonly label: string }[],
): DecisionTexts {
  return {
    summary: report.summary,
    next_steps: report.next_steps,
    options: [
      ...report.options.map((option, index) => ({
        key: `${DECISION_FIX_OPTION_PREFIX}${index + 1}`,
        generated: true,
        label: option.label,
        note: option.description,
        criteria_rewrites: option.criteria_rewrites.map(({ criterion_id, after, check }) => ({ criterion_id, after, check })),
      })),
      ...options.map((option) => ({
        key: option.key,
        generated: false,
        label: option.label,
        note: report.option_notes.find((entry) => entry.key === option.key)?.note ?? "",
        criteria_rewrites: [],
      })),
    ],
  };
}

/** Put texts back into the report they came from: summary, next_steps, fix labels, descriptions, rewrites by criterion_id, notes by key. */
export function applyDecisionTexts(report: DecisionExplanationReport, texts: DecisionTexts): DecisionExplanationReport {
  const generated = texts.options.filter((option) => option.generated);
  const notes = new Map(texts.options.filter((option) => !option.generated).map((option) => [option.key, option.note]));
  return {
    ...report,
    summary: texts.summary,
    next_steps: texts.next_steps,
    option_notes: report.option_notes.map((entry) => ({ key: entry.key, note: notes.get(entry.key) ?? entry.note })),
    options: report.options.map((option, index) => {
      const text = generated[index];
      if (!text) return option;
      return {
        ...option,
        label: text.label,
        description: text.note,
        criteria_rewrites: option.criteria_rewrites.map((rewrite) => {
          const fixed = text.criteria_rewrites.find((entry) => entry.criterion_id === rewrite.criterion_id);
          return fixed ? { criterion_id: rewrite.criterion_id, after: fixed.after, check: fixed.check } : rewrite;
        }),
      };
    }),
  };
}

export const DECISION_TEXT_CHECK_PROBLEMS_MAX = 10;
export const DECISION_TEXT_CHECK_OUTPUT_MAX_BYTES = 64 * 1024;

/** What a text check receives: the texts after the common checks, never internal ids. */
export interface DecisionTextCheckInput {
  readonly language: "ja" | "en";
  readonly kind: DecisionExplanationKind;
  readonly texts: DecisionTexts;
}

export type DecisionTextCheckOutput =
  /** The texts are fine; fixed, when given, replaces them. */
  | { readonly ok: true; readonly fixed?: DecisionTexts }
  /** The texts break the checker's rules; each problem is one short sentence the model can act on. */
  | { readonly ok: false; readonly problems: readonly string[] };

const isTextRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isFilled = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function readFixedTexts(value: unknown, input: DecisionTexts): { readonly ok: true; readonly value: DecisionTexts } | { readonly ok: false; readonly problem: string } {
  if (!isTextRecord(value)) return { ok: false, problem: "fixed must be an object" };
  if (!isFilled(value.summary) || !isFilled(value.next_steps)) return { ok: false, problem: "fixed summary and next_steps must be non-empty strings" };
  if (!Array.isArray(value.options) || value.options.length !== input.options.length) return { ok: false, problem: "fixed options must keep the options of the input" };
  const options: DecisionTexts["options"][number][] = [];
  for (const [index, expected] of input.options.entries()) {
    const option: unknown = value.options[index];
    if (!isTextRecord(option) || option.key !== expected.key || option.generated !== expected.generated) {
      return { ok: false, problem: "fixed options must keep key, generated and order" };
    }
    if (!isFilled(option.label) || !isFilled(option.note)) return { ok: false, problem: `fixed label and note of option ${expected.key} must be non-empty strings` };
    if (!expected.generated && option.label !== expected.label) return { ok: false, problem: `fixed must not change the label of option ${expected.key}` };
    const rewrites: unknown = option.criteria_rewrites;
    if (!Array.isArray(rewrites) || rewrites.length !== expected.criteria_rewrites.length) return { ok: false, problem: `fixed criteria_rewrites of option ${expected.key} must keep the input's` };
    const fixedRewrites: DecisionTextRewrite[] = [];
    for (const [at, want] of expected.criteria_rewrites.entries()) {
      const rewrite: unknown = rewrites[at];
      if (!isTextRecord(rewrite) || rewrite.criterion_id !== want.criterion_id) return { ok: false, problem: "fixed must keep criterion_id and its order" };
      if (!isFilled(rewrite.after) || !isFilled(rewrite.check)) return { ok: false, problem: "fixed after and check must be non-empty strings" };
      fixedRewrites.push({ criterion_id: want.criterion_id, after: rewrite.after, check: rewrite.check });
    }
    options.push({ key: expected.key, generated: expected.generated, label: option.label, note: option.note, criteria_rewrites: fixedRewrites });
  }
  return { ok: true, value: { summary: value.summary, next_steps: value.next_steps, options } };
}

/** Never throws. fixed must keep the shape of input.texts: option keys, generated flags and order, Core's labels, and each option's criterion_ids in order. */
export function readDecisionTextCheckOutput(
  value: unknown,
  input: DecisionTextCheckInput,
): { readonly ok: true; readonly value: DecisionTextCheckOutput } | { readonly ok: false; readonly problem: string } {
  try {
    if (!isTextRecord(value) || typeof value.ok !== "boolean") return { ok: false, problem: "ok must be a boolean" };
    if (!value.ok) {
      const problems = value.problems;
      if (!Array.isArray(problems) || problems.length === 0 || !problems.every(isFilled)) return { ok: false, problem: "problems must be a non-empty array of non-empty strings" };
      return { ok: true, value: { ok: false, problems: problems.slice(0, DECISION_TEXT_CHECK_PROBLEMS_MAX) as string[] } };
    }
    if (value.fixed === undefined) return { ok: true, value: { ok: true } };
    const fixed = readFixedTexts(value.fixed, input.texts);
    return fixed.ok ? { ok: true, value: { ok: true, fixed: fixed.value } } : fixed;
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : "invalid text check output" };
  }
}

/**
 * Requests that the Owner do the Manager's or a Worker's work (remake a Task, reword criteria, fix the plan, run a command).
 * A sentence needs an Owner-facing request ending and such an object; the Manager's instruction is never checked.
 */
const MANAGER_WORK_REQUESTS: readonly RegExp[] = [
  /(?:Task|タスク|受け入れ条件|条件|計画|プラン|テスト|コマンド)[^。！？\n]*(?:作り直|作り替|書き直|書き換|立て直|組み直|やり直|修正|変更|実行|追加|更新|直し)[^。！？\n]*(?:ください|下さい|お願い|てほしい|する必要|ましょう|なさい|て(?:もらえ|いただけ|くれ)(?:ます|ません)?か)/u,
  /`[^`\n]+`[^。！？\n]*(?:実行|走ら)[^。！？\n]*(?:ください|下さい|お願い|てほしい|する必要|ましょう|なさい|て(?:もらえ|いただけ|くれ)(?:ます|ません)?か)/u,
  /\b(?:please|you (?:need|have|must|should)\b)[^.!?\n]*\b(?:recreat\w*|re-?creat\w*|rewrit\w*|reword\w*|re-?run|replan\w*|amend\w*|run|execute|fix|update|edit)\b[^.!?\n]*(?:\b(?:tasks?|criteri\w+|plans?|commands?|tests?)\b|`)/iu,
];

/**
 * A bare imperative opening a sentence, also in a choice's label or note: a note says what happens ("The Manager reruns the tests."),
 * not what the Owner should do. A question ("Rewrite the criteria and go on?") is a choice for the Owner, so it is not matched.
 * Only running a command is matched on a backticked name alone: "Edit `layouts/x.yaml`." may be the Owner's own file.
 */
const MANAGER_WORK_IMPERATIVES: readonly RegExp[] = [
  /(?:^|[.!。]\s*|\n)(?:re-?create|rewrite|reword|replan|amend|fix|update|edit)\b[^.!?\n]*\b(?:tasks?|criteri\w+|plans?|commands?|tests?)\b[^.!?\n]*(?:[.!]|$)/iu,
  /(?:^|[.!。]\s*|\n)(?:re-?run|run|execute)\b(?:`[^`\n]*`|[^.!?\n])*(?:\b(?:tasks?|commands?|tests?)\b|`)(?:`[^`\n]*`|[^.!?\n])*(?:[.!]|$)/iu,
];

const BARE_RETRY_OR_CANCEL = /もう一度|もう1度|再度|同じ|まま|内容|こと|よう|で|を|に|は|し|て|み|ます|か|する|す|今回|再?実行|再?試行|試|やり直|中止|キャンセル|取り消|見送り?|やめ|\b(?:do|you|want|would|like|to|shall|we|retry|cancel|try|again|run|it|this|the|same|work|task|stop|abandon)\b|タスク|作業|処理/giu;

/** A choice that only repeats the fixed retry or cancel ("もう一度実行しますか？") is not a choice that fits the situation. */
const isBareRetryOrCancel = (label: string): boolean => label.replace(BARE_RETRY_OR_CANCEL, "").replace(/[？?。.\s]/gu, "") === "";

/** The parts of text that ask the Owner for the Manager's or a Worker's work. */
export function findManagerWorkRequests(text: string): string[] {
  return [...MANAGER_WORK_REQUESTS, ...MANAGER_WORK_IMPERATIVES].flatMap((pattern) => pattern.exec(text)?.slice(0, 1) ?? []);
}

/** Requests for internal work and internal terms in the texts; [] when they are fine. */
export function findDecisionTextProblems(texts: DecisionTexts, forbiddenTerms: readonly string[]): string[] {
  const problems: string[] = [];
  // Core's own labels are fixed text, so only the labels the model wrote are checked.
  const asked = [
    texts.summary,
    texts.next_steps,
    ...texts.options.flatMap((option) => [...(option.generated ? [option.label] : []), option.note]),
  ].flatMap((text) => findManagerWorkRequests(text));
  if (asked.length > 0) {
    problems.push(`Do not ask the Owner to do the Manager's or a Worker's work (${asked.join(" / ")}). Write the way forward as choices the Owner can pick; the Manager does the work after the pick.`);
  }
  const shown = [
    texts.summary,
    texts.next_steps,
    ...texts.options.flatMap((option) => [
      ...(option.generated ? [option.label] : []),
      option.note,
      ...option.criteria_rewrites.flatMap((rewrite) => [rewrite.after, rewrite.check]),
    ]),
  ];
  for (const text of shown) {
    const terms = findInternalTerms(text, forbiddenTerms);
    if (terms.length > 0) {
      problems.push(`Rephrase without the internal terms: ${terms.join(", ")}. Say it in the Owner's words; if it is a name from the Owner's own project (a setting or file name), write it in backticks.`);
      break;
    }
  }
  return problems;
}

/** Never throws; problem says what to fix so the runner can ask the model again. */
export function readDecisionExplanation(
  value: unknown,
  context: DecisionExplanationCheckContext,
): { readonly ok: true; readonly value: DecisionExplanationReport } | { readonly ok: false; readonly problem: string } {
  try {
    const schemaProblem = validateRoleOutput(DECISION_EXPLANATION_SCHEMA, value);
    if (schemaProblem !== null) return { ok: false, problem: schemaProblem };
    const report = value as DecisionExplanationReport;
    const allowsFix = DECISION_FIX_OPTION_KINDS.includes(context.kind);
    // RoleSchema has no per-kind item counts, so they are checked here.
    if (allowsFix && report.options.length < DECISION_FIX_OPTIONS_MIN) {
      return { ok: false, problem: "options must have at least one choice that fits this situation, not only retry and cancel" };
    }
    if (allowsFix && report.options.every((option) => isBareRetryOrCancel(option.label))) {
      return { ok: false, problem: "options must have at least one choice that fits this situation, not a rewording of retry or cancel" };
    }
    if (!allowsFix && report.options.length > 0) return { ok: false, problem: "options must be []" };
    const noteKeys = report.option_notes.map((entry) => entry.key);
    const ownKeys = context.options.map((option) => option.key);
    if (new Set(noteKeys).size !== noteKeys.length) return { ok: false, problem: "option_notes repeats a key" };
    const missing = ownKeys.filter((key) => !noteKeys.includes(key));
    if (missing.length > 0) return { ok: false, problem: `option_notes lacks the options: ${missing.join(", ")}` };
    const extra = noteKeys.filter((key) => !ownKeys.includes(key));
    if (extra.length > 0) return { ok: false, problem: `option_notes has keys that are not options of the Decision: ${extra.join(", ")}` };
    const key = report.recommended_option_key;
    if (context.recommended !== null) {
      if (key !== context.recommended) return { ok: false, problem: `recommended_option_key must be ${context.recommended}` };
    } else {
      const allowed = allowsFix ? report.options.map((_, index) => `${DECISION_FIX_OPTION_PREFIX}${index + 1}`) : ownKeys;
      if (!allowed.includes(key)) return { ok: false, problem: `recommended_option_key must be one of: ${allowed.join(", ")}` };
    }
    for (const option of report.options) {
      const ids = option.criteria_rewrites.map((rewrite) => rewrite.criterion_id);
      const unknown = ids.find((id) => !context.criterion_ids.includes(id));
      if (unknown !== undefined) return { ok: false, problem: `criterion_id ${unknown} is not a criterion of the Task` };
      if (new Set(ids).size !== ids.length) return { ok: false, problem: "criteria_rewrites repeats a criterion_id within one option" };
    }
    if (allowsFix && report.cause_kind === "criteria" && !report.options.some((option) => option.criteria_rewrites.length > 0)) {
      return { ok: false, problem: "cause_kind criteria needs an option with criteria_rewrites" };
    }
    const problems = findDecisionTextProblems(decisionTextsOf(report, context.options), context.forbidden_terms);
    if (problems.length > 0) return { ok: false, problem: problems[0]! };
    return { ok: true, value: report };
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : "invalid explanation" };
  }
}

export interface DecisionCriterionRewrite {
  /** Id of the Task criterion, for the Manager; never shown to the Owner. */
  readonly criterion_id: string;
  /** Original criterion text, copied from the Task by Core. */
  readonly before: string;
  readonly after: string;
  readonly check: string;
}

export interface DecisionFixOption {
  /** DECISION_FIX_OPTION_PREFIX + number, "fix_1", "fix_2", .... */
  readonly key: string;
  readonly label: string;
  readonly description: string;
  /** Body of the instruction sent to the Manager. */
  readonly instruction: string;
  /** Empty unless the cause is the criteria. */
  readonly criteria_rewrites: readonly DecisionCriterionRewrite[];
}

export interface StoredDecisionExplanation {
  readonly kind: DecisionExplanationKind;
  readonly status: "pending" | "ready" | "failed";
  /** Only when status is ready. */
  readonly summary?: string;
  /** Only when status is ready. */
  readonly cause_kind?: DecisionCauseKind;
  /** Only when status is ready: what the Owner can do. Absent on rows written before this change. */
  readonly next_steps?: string;
  /** Only when status is ready: one note per option the Decision had before the explanation. Absent on older rows. */
  readonly option_notes?: readonly { readonly key: string; readonly note: string }[];
  /** Only when status is failed, or plain is true: why the model's explanation was not stored, e.g. "timeout". */
  readonly error?: string;
  /** true when Core wrote the summary and next_steps itself (status ready) because the model's explanation could not be stored. */
  readonly plain?: boolean;
}

/** The runner request and result; Core and agent-runtime both import them from here. */
export interface DecisionExplanationRequest {
  readonly invocation_id?: string;
  readonly kind: DecisionExplanationKind;
  readonly language: "ja" | "en";
  readonly decision: {
    readonly reason: string;
    readonly question: string;
    readonly current_state: string;
    readonly tried: string;
    readonly options: readonly { readonly key: string; readonly label: string; readonly description: string }[];
    readonly recommended: string | null;
  };
  readonly task: { readonly title: string; readonly acceptance_criteria: readonly { readonly id: string; readonly text: string; readonly check?: string }[] } | null;
  readonly reports: readonly JsonObject[];
  readonly verification: JsonObject | null;
  readonly rules: string | null;
  readonly forbidden_terms: readonly string[];
  /** Set only when asking for a rewrite after a text check found problems. */
  readonly revision: { readonly texts: DecisionTexts; readonly problems: readonly string[] } | null;
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly timeout_ms: number;
}
export type DecisionExplanationRunResult =
  | { readonly ok: true; readonly explanation: DecisionExplanationReport }
  | { readonly ok: false; readonly error: string };
