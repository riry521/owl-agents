/** @typedef {{ text: string, path: string | null }} PathSegment */

// Judged by the characters alone: the Web does not know where the Project and materials are.
// Core decides what can be read; here only paths that Core would always refuse are left as text.
const DELIMITERS = '\\s\\u3000「」『』（）()【】［］\\[\\]{}〈〉《》<>、。，．,;；:：・`\'"“”‘’*|!！?？=';
const LINK_PATTERN = new RegExp(
  '[a-z][a-z0-9+.-]*://[^\\s\\u3000]*'
  + `|(?<![^${DELIMITERS}])(?<path>[^${DELIMITERS}]+?\\.md)(?![A-Za-z0-9_\\-/\\\\]|\\.[A-Za-z0-9])`,
  'giu',
);
const linkable = (path) => !path.startsWith('~') && !path.includes('\\') && !path.split('/').includes('..');

/**
 * Splits prose into plain text and linkable Markdown paths, keeping every character in order.
 * @returns {PathSegment[]}
 */
export function splitMarkdownPaths(text) {
  const segments = [];
  let at = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    const path = match.groups?.path;
    if (path === undefined || !linkable(path)) continue;
    if (match.index > at) segments.push({ text: text.slice(at, match.index), path: null });
    segments.push({ text: path, path });
    at = match.index + path.length;
  }
  if (at < text.length) segments.push({ text: text.slice(at), path: null });
  return segments;
}

/** The linkable path when the whole string is one path, else null. */
export function markdownLinkPath(file) {
  const segments = splitMarkdownPaths(file);
  return segments.length === 1 ? segments[0].path : null;
}

/** The viewer's href without the basePath. */
export function markdownViewerHref(workId, path) {
  return `/work/markdown?${new URLSearchParams({ id: workId, path })}`;
}
