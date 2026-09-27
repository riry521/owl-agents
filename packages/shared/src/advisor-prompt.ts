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
