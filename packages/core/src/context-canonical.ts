/** UTF-16 code unit order. Never localeCompare: its result depends on the ICU locale. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Trim, drop empty strings, dedupe, then sort by compareText. */
export function uniqueSorted(values: Iterable<string>): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed !== "") unique.add(trimmed);
  }
  return [...unique].sort(compareText);
}
