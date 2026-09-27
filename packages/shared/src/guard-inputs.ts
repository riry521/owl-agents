/**
 * Which tool arguments Owl's guard reads. The server-side rule check and the
 * PreToolUse hook share these lists, so the hook can allow a call locally
 * when there is nothing the guard would check.
 */

/** Tools the guard checks by name, denying a call whose target cannot be determined. */
export const GUARD_NAMED_TOOLS: ReadonlySet<string> = new Set([
  "read", "read_file", "open",
  "glob", "grep", "search", "ripgrep",
  "edit", "write", "multiedit", "notebookedit", "write_file", "apply_patch",
  "bash", "shell", "terminal", "exec", "command",
]);

/** Argument names that tools, MCP tools included, commonly use for file paths. */
export const GUARD_PATH_KEYS: readonly string[] = [
  "file_path", "path", "paths", "filename", "file", "files", "notebook_path", "relative_path", "relative_paths",
  "target_file", "directory", "dir", "source_path", "destination_path", "root_path",
];

/** Argument names that tools commonly use for shell commands. */
export const GUARD_COMMAND_KEYS: readonly string[] = ["command", "cmd", "script", "commands", "shell_command", "command_line"];

/** Arguments that carry new file content, which make a tool call a write. */
export const GUARD_CONTENT_KEYS: readonly string[] = ["content", "contents", "new_string", "new_text", "body", "data", "patch", "diff"];

function hasCheckableValue(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  return Array.isArray(value) && value.some((item) => typeof item === "string" && item.length > 0);
}

/**
 * Whether the guard has anything to check in this call: always for the named
 * tools, otherwise only when a path-like or command-like argument is present.
 */
export function guardChecksToolCall(toolName: string, toolInput: Readonly<Record<string, unknown>>): boolean {
  if (GUARD_NAMED_TOOLS.has(toolName.toLowerCase())) return true;
  return [...GUARD_PATH_KEYS, ...GUARD_COMMAND_KEYS].some((key) => hasCheckableValue(toolInput[key]));
}
