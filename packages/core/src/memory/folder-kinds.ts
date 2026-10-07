import type { FolderKindRule, MemoryFolderKinds } from "@owl/shared";

const cache = new Map<string, RegExp>();

/** `**` matches across folders, `*` within one folder. Everything else is literal. */
export function matchGlob(glob: string, path: string): boolean { return globToRegExp(glob).test(path); }
function globToRegExp(glob: string): RegExp {
  let regex = cache.get(glob);
  if (!regex) {
    const source = glob.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replace(/\*\*\/?|\*/gu, (m) => (m === "*" ? "[^/]*" : m.endsWith("/") ? "(?:.*/)?" : ".*"));
    regex = new RegExp(`^${source}$`, "u");
    cache.set(glob, regex);
  }
  return regex;
}

/** First matching rule wins. */
export function matchFolderKind(kinds: MemoryFolderKinds, path: string): FolderKindRule | null {
  return kinds.rules.find((rule) => globToRegExp(rule.glob).test(path)) ?? null;
}
