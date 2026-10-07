import { isAbsolute } from "node:path";

/**
 * Fixed guidance for an agent whose working directory is a git worktree of
 * the user's project: the user's own MCP servers and skills apply there,
 * semantic/reference/impact-analysis tools should be preferred over
 * exhaustive file reads, and a stale or unbuilt tool index should be
 * refreshed rather than trusted as empty. Returns null when no usable
 * absolute worktree path was supplied, so callers can skip the section
 * entirely.
 */
export function renderWorkspaceToolsNote(worktree: string | null | undefined): string[] | null {
  const path = worktree?.trim();
  if (!path || !isAbsolute(path)) return null;
  return [
    `- You are working in the git worktree ${path}. The user's MCP servers and project skills are configured the same as in the main checkout and operate on this worktree.`,
    "- For finding files or symbols, tracing references and callers, and estimating the impact of a change, prefer the semantic search, reference search and impact-analysis tools available to you. Read files exhaustively only when no such tool is available or it did not answer the question.",
    "- If a tool reports that its index, graph or project for this workspace is missing or stale, build or refresh it with that tool's own command before relying on it. Never treat empty results from an unbuilt index as evidence that something does not exist.",
  ];
}
