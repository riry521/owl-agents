const SLACK_ADVISOR_REPLY_INSTRUCTION = [
  "The reply target for this turn is Slack.",
  "Write user-visible text in Slack mrkdwn: use *bold* with single asterisks, _italic_, ~strike~, <url|text> links, and • bullets. Do not use # headings or tables.",
  "Code fences and inline code are allowed.",
  "The owl-actions fence format is unchanged. Whenever creating a Work, still emit the required action in exactly one standard triple-backtick `owl-actions` fenced block: an opening line that is exactly ```owl-actions, a newline, a valid JSON array exactly as specified elsewhere in this prompt, a newline, and a closing line that is exactly ```.",
  "Keep that action block unchanged. Core parses and strips it before display; never convert or reformat it.",
].join("\n");

/** Return the Slack-only formatting and action-fence guidance. */
export function buildSlackFormatInstruction(): string {
  return SLACK_ADVISOR_REPLY_INSTRUCTION;
}

/** Append interface-specific guidance while preserving non-Slack prompts byte-for-byte. */
export function applyAdvisorInterfaceInstructions(prompt: string, interfaceKind: string): string {
  if (interfaceKind.trim().toLowerCase() !== "slack") return prompt;
  if (prompt.length === 0) return buildSlackFormatInstruction();
  return `${prompt}\n\n${buildSlackFormatInstruction()}`;
}

/** Add reply-target guidance without changing prompts for non-Slack interfaces. */
export function addAdvisorReplyTargetInstruction(prompt: string, replyTarget: string): string {
  if (replyTarget.trim().toLowerCase() !== "slack") return prompt;
  return `${buildSlackFormatInstruction()}\n\n${prompt}`;
}

/**
 * How the Advisor must answer the three tidy-up requests. Core runs the
 * curation itself and appends its summary, so guessing the outcome here would
 * show the operator numbers that were never recorded.
 */
export const ADVISOR_CURATION_INSTRUCTION = [
  "Tidy-up requests: when the operator asks to tidy the knowledge (\"ナレッジ整理して\"), emit exactly one owl-actions entry {type:\"run_librarian\",description,payload:{}} in that same turn. Answer \"スキル整理して\" with {type:\"run_skill_curation\",description,payload:{}} and \"ルール整理して\" with {type:\"run_rule_curation\",description,payload:{}}.",
  "Always emit the matching action in the same turn, and never answer a tidy-up request with create_work: Core executes the curation, records the run and appends that run's summary (counts and main items) to your reply, so do not guess or describe the result yourself.",
  "run_rule_curation never rewrites rules: it only reports the rule proposals that are waiting for the Owner's approval and the findings about the current rules. Tell the operator that changing a rule needs the Owner's approval.",
].join(" ");
