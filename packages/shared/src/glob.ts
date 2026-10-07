/**
 * A small glob: `**` (any depth, `**` + `/` also matches zero directories),
 * `*` and `?` (within one path segment), `{a,b}` alternatives. `/` separates
 * segments. Every other character matches itself. Throws on an unbalanced `{`.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  let braceDepth = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        const slash = pattern[index + 2] === "/";
        source += slash ? "(?:.*/)?" : ".*";
        index += slash ? 2 : 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "{") {
      braceDepth += 1;
      source += "(?:";
    } else if (char === "}" && braceDepth > 0) {
      braceDepth -= 1;
      source += ")";
    } else if (char === "," && braceDepth > 0) {
      source += "|";
    } else {
      source += char.replace(/[.+^$()|[\]\\{}]/g, "\\$&");
    }
  }
  if (braceDepth !== 0) throw new Error(`Unbalanced "{" in glob: ${pattern}`);
  return new RegExp(`^${source}$`, "su");
}

/** Whether `path` (with `/` separators, no leading `./`) matches any pattern. */
export function matchesAnyGlob(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}
