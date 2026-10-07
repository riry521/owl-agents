import { analyzeShellCommand } from "./command-analysis.js";
import type { TestPolicy } from "../../shared/dist/test-policy.js";
import type { TestRunSettings } from "../../shared/dist/test-run-settings.js";

export type ReviewerTestCommandCheck = { readonly denied: false } | { readonly denied: true; readonly matched: string; readonly message: string };

export const REVIEWER_TEST_COMMAND_DENIED_MESSAGE = "Reviewers do not run the Project's tests; judge from Review.core_tests.";

const FILE_PLACEHOLDER = "{file}";
const OPTION_WITH_VALUE = /^-[^=]*=/u;

const normalizeWords = (words: readonly string[]): string[] => words.filter((word) => !OPTION_WITH_VALUE.test(word));

/** The word prefixes a Reviewer may not run, all derived from the Project's settings. */
export function reviewerDeniedCommands(settings: TestRunSettings | null, policy: TestPolicy): string[][] {
  const prefixes: string[][] = [];
  if (settings?.mode === "per_file") {
    const index = settings.file_argv.indexOf(FILE_PLACEHOLDER);
    prefixes.push(index < 0 ? [...settings.file_argv] : settings.file_argv.slice(0, index));
  }
  if (settings !== null && settings.whole_argv.length > 0) prefixes.push([...settings.whole_argv]);
  for (const command of policy.reviewer_denied_commands) prefixes.push(command.trim().split(/\s+/u));
  return prefixes.map(normalizeWords).filter((prefix) => prefix.length > 0);
}

/** The first denied prefix that starts one of the command's word lists, or null. */
export function matchDeniedCommand(command: string, prefixes: readonly (readonly string[])[]): string[] | null {
  // An unparseable command is already denied by RuleStore.checkCommand, so there is nothing to match here.
  const lists = (analyzeShellCommand(command)?.segments ?? []).map(normalizeWords);
  for (const prefix of prefixes) {
    const normalized = normalizeWords(prefix);
    if (normalized.length === 0) continue;
    if (lists.some((words) => words.length >= normalized.length && normalized.every((word, i) => words[i] === word))) return [...normalized];
  }
  return null;
}
