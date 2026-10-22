import { redactSecrets } from "./post-merge-command";
import type { CriterionCheck, JsonObject, RuleApplicability } from "./types";

/** passed / failed: the command ran; not_allowed: it is not a command the Project allows, so it was not run; skipped: there was nowhere to run it. */
export type CriterionCheckStatus = "passed" | "failed" | "not_allowed" | "skipped";

export interface CriterionCheckResult {
  readonly criterion_id: string;
  readonly argv: readonly string[];
  readonly status: CriterionCheckStatus;
  readonly exit_code: number | null;
  readonly timed_out: boolean;
  /** The last OUTPUT_TAIL_CHARS characters of stdout and stderr, after redactSecrets. */
  readonly output_tail: string;
}

/** How much of a command's output the record keeps. */
export const OUTPUT_TAIL_CHARS = 4000;

/** What running one command returns; the same shape WorkflowEngine's verification runner has. */
export interface CriterionCommandOutcome {
  readonly passed?: boolean;
  readonly exit_code?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly timed_out?: boolean;
  readonly error?: string;
}

export interface RunCriterionChecksInput {
  readonly checks: readonly CriterionCheck[];
  /** The commands the Project allows (argv arrays); a check matches only when its argv starts with one of them. */
  readonly allowed: readonly (readonly string[])[];
  /** The Task's last worktree; null when it is gone. */
  readonly cwd: string | null;
  readonly run: (argv: readonly string[], cwd: string) => Promise<CriterionCommandOutcome>;
}

/** A check matches an allowed command when its argv starts with that command's argv, so a test command may name its own files. */
const startsWithArgv = (argv: readonly string[], allowed: readonly string[]): boolean => allowed.length > 0 && allowed.length <= argv.length && allowed.every((part, index) => part === argv[index]);

/**
 * Words of a plain command line ("pnpm test", "node --test 'a b'"), or null when it needs a shell (pipes, variables, escapes).
 * Why null instead of a best effort: the words are run with shell: false, so a line that meant a shell feature must not be run as words.
 * Words from the first "{file}" placeholder on are dropped: the allowed command is the part before it.
 */
export function splitPlainCommand(line: string): string[] | null {
  if (/[|&;<>$`()\\\n"*?~#]/u.test(line.replace(/'[^']*'/gu, ""))) return null;
  const words = [...line.matchAll(/'([^']*)'|(\S+)/gu)].map((match) => match[1] ?? match[2]);
  const cut = words.findIndex((word) => word.includes("{file}"));
  const argv = cut < 0 ? words : words.slice(0, cut);
  return argv.length > 0 ? argv : null;
}

/** The tail of what the command printed, with secrets masked. The mask runs on the whole text first so a secret cut by the tail is not left half visible. */
export function outputTail(outcome: CriterionCommandOutcome): string {
  const text = [outcome.stdout ?? "", outcome.stderr ?? "", outcome.error ?? ""].filter((part) => part.length > 0).join("\n");
  const masked = redactSecrets(text);
  return masked.length > OUTPUT_TAIL_CHARS ? masked.slice(masked.length - OUTPUT_TAIL_CHARS) : masked;
}

/**
 * Run the Manager's checks one by one, each once and in the given order. A command that is not allowed is not run.
 * Nothing here uses a shell: `run` receives the argv as it is.
 */
export async function runCriterionChecks(input: RunCriterionChecksInput): Promise<CriterionCheckResult[]> {
  const results: CriterionCheckResult[] = [];
  for (const check of input.checks) {
    const base = { criterion_id: check.criterion_id, argv: [...check.argv] };
    if (!input.allowed.some((allowed) => startsWithArgv(check.argv, allowed))) {
      results.push({ ...base, status: "not_allowed", exit_code: null, timed_out: false, output_tail: "" });
      continue;
    }
    if (input.cwd === null) {
      results.push({ ...base, status: "skipped", exit_code: null, timed_out: false, output_tail: "" });
      continue;
    }
    let outcome: CriterionCommandOutcome;
    try {
      outcome = await input.run(check.argv, input.cwd);
    } catch (error) {
      outcome = { passed: false, error: error instanceof Error ? error.message : String(error) };
    }
    results.push({
      ...base,
      status: outcome.passed === true ? "passed" : "failed",
      exit_code: typeof outcome.exit_code === "number" ? outcome.exit_code : null,
      timed_out: outcome.timed_out === true,
      output_tail: outputTail(outcome),
    });
  }
  return results;
}

export const toJsonResults = (results: readonly CriterionCheckResult[]): JsonObject[] => results.map((result) => ({ ...result, argv: [...result.argv] }));

/** Heading of the section the Manager's rule judgements add to a Task's notes. */
export const RULE_SECTION_HEADING = "ルールの当てはめ（Manager の判断）";

/** The section appended to the end of the notes: one line per judged rule. */
export function ruleApplicabilitySection(rules: readonly RuleApplicability[]): string {
  const lines = rules.map((rule) => `${rule.criterion_id}: 規則『${rule.rule}』は${rule.applies ? "当てはまります" : "当てはまりません"}。理由: ${rule.reason}`);
  return [RULE_SECTION_HEADING, ...lines].join("\n");
}

/** notes with the section after them, one blank line between. */
export function appendRuleSection(notes: string | null | undefined, rules: readonly RuleApplicability[]): string {
  const section = ruleApplicabilitySection(rules);
  return notes === null || notes === undefined || notes.trim() === "" ? section : `${notes.replace(/\s+$/u, "")}\n\n${section}`;
}
