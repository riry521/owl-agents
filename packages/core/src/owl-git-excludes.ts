/**
 * Machine-local tool output that never belongs in a repository. Owl passes
 * these patterns to every git command as `core.excludesFile`, in addition to
 * the repository's own ignore rules. Tracked files are unaffected.
 */
export const OWL_GIT_EXCLUDES: readonly string[] = [
  ".code-review-graph/",
  ".serena/",
  ".DS_Store",
  "__pycache__/",
  "*.pyc",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ruff_cache/",
];

export const OWL_GIT_EXCLUDES_CONTENT = `${OWL_GIT_EXCLUDES.join("\n")}\n`;
