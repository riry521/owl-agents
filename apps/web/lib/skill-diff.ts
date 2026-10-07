// Client-side line diff for comparing two skill file revisions. Common leading
// and trailing lines are trimmed first, then the remaining middle is diffed
// with a longest-common-subsequence table stored in one flat typed array. When
// that table would be too large, the diff is reported as too large instead of
// freezing the page.

export type DiffLineKind = 'context' | 'added' | 'removed';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLineNo: number | null;
  newLineNo: number | null;
}

export type DiffResult = { tooLarge: false; lines: DiffLine[] } | { tooLarge: true; lines: null };

/** Upper bound on LCS table cells ((n + 1) * (m + 1)) for the trimmed middle. */
const MAX_TABLE_CELLS = 2_000_000;

function splitLines(text: string): string[] {
  if (text === '') return [];
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed.split('\n');
}

export function diffLines(oldText: string, newText: string): DiffResult {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const n = a.length - prefix - suffix;
  const m = b.length - prefix - suffix;
  const width = m + 1;
  if ((n + 1) * width > MAX_TABLE_CELLS) return { tooLarge: true, lines: null };

  const lines: DiffLine[] = [];
  for (let k = 0; k < prefix; k++) {
    lines.push({ kind: 'context', text: a[k], oldLineNo: k + 1, newLineNo: k + 1 });
  }

  // dp[i * width + j] = LCS length of a[prefix + i ..] and b[prefix + j ..] within the middle.
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[prefix + i] === b[prefix + j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  let oldNo = prefix + 1;
  let newNo = prefix + 1;
  while (i < n && j < m) {
    const oldLine = a[prefix + i];
    const newLine = b[prefix + j];
    if (oldLine === newLine) {
      lines.push({ kind: 'context', text: oldLine, oldLineNo: oldNo++, newLineNo: newNo++ });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      lines.push({ kind: 'removed', text: oldLine, oldLineNo: oldNo++, newLineNo: null });
      i++;
    } else {
      lines.push({ kind: 'added', text: newLine, oldLineNo: null, newLineNo: newNo++ });
      j++;
    }
  }
  while (i < n) {
    lines.push({ kind: 'removed', text: a[prefix + i], oldLineNo: oldNo++, newLineNo: null });
    i++;
  }
  while (j < m) {
    lines.push({ kind: 'added', text: b[prefix + j], oldLineNo: null, newLineNo: newNo++ });
    j++;
  }

  for (let k = 0; k < suffix; k++) {
    lines.push({ kind: 'context', text: a[prefix + n + k], oldLineNo: oldNo++, newLineNo: newNo++ });
  }
  return { tooLarge: false, lines };
}

export function diffSummary(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === 'added') added++;
    else if (line.kind === 'removed') removed++;
  }
  return { added, removed };
}

export interface FileDiff {
  path: string;
  /** Null when the file was too large to diff. */
  lines: DiffLine[] | null;
  added: number;
  removed: number;
}

/** Per-file diffs between two file maps, skipping unchanged files. */
export function diffFileMaps(before: Record<string, string>, after: Record<string, string>): FileDiff[] {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const diffs: FileDiff[] = [];
  for (const path of paths) {
    const b = before[path] ?? '';
    const a = after[path] ?? '';
    if (a === b) continue;
    const result = diffLines(b, a);
    if (result.tooLarge) {
      diffs.push({ path, lines: null, added: 0, removed: 0 });
    } else {
      diffs.push({ path, lines: result.lines, ...diffSummary(result.lines) });
    }
  }
  return diffs;
}

/** A byte count formatted like "2.1 KB". */
export function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** UTF-8 byte length of a file's content, formatted like "2.1 KB". */
export function formatByteSize(content: string): string {
  return formatByteCount(new TextEncoder().encode(content).length);
}
