/**
 * Tools whose call reaches outside the worktree (messages, remote triggers,
 * external MCP servers, shell commands such as gh/curl/deploy), so running the Task again would repeat the effect.
 * A trailing `*` matches a prefix. Override with AgentRunnerOptions.sideEffectTools.
 */
export const DEFAULT_SIDE_EFFECT_TOOLS: readonly string[] = ["mcp__*", "SendMessage", "PushNotification", "RemoteTrigger", "Bash"];

export function isSideEffectTool(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern);
}
