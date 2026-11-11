// @ts-check
/** @typedef {{ key: string, path: string }} OwnerFileRoot */

const DELIMITERS = '\\s\\u3000「」『』（）()【】［］\\[\\]{}〈〉《》<>、。，．,;；:：`\'"“”‘’*|!！?？=';
/** @param {string} text */
// web は @owl/shared に依存しない（ブラウザ向けの bundle に node:crypto を含む shared を入れない）ので、shared の escapeRegExp を読めない。
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether an href points at the owner-files route (so it must open in a new tab).
 * @param {unknown} href @param {string} apiBase @param {string} [viewerBase]
 */
export function isOwnerFileHref(href, apiBase, viewerBase) {
  if (typeof href !== 'string') return false;
  // Without roots apiBase is '' and links come straight from the reply text, so match the route under any prefix such as /api/v1.
  return (apiBase ? href.startsWith(`${apiBase}/owner-files/`) : /^\/(?:[^/?#]+\/)*owner-files\//.test(href))
    || (viewerBase !== undefined && href.startsWith(`${viewerBase}/work/markdown?root=`));
}

/**
 * Extra props for the <a> of an owner-files link; empty for any other link.
 * @param {unknown} href @param {string} apiBase @param {string} [viewerBase]
 */
export function ownerFileAnchorProps(href, apiBase, viewerBase) {
  return isOwnerFileHref(href, apiBase, viewerBase) ? { target: '_blank', rel: 'noopener noreferrer' } : {};
}

/** @param {string} segment */
function decode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Builds the converter for one set of roots. `apiBase` (e.g. "/api/v1") is where the owner-files route lives.
 * Prefix-only look-alikes (/x/materials-old) and ".." paths are left as they are: Core would refuse them.
 * `viewerBase` (the app's basePath) turns .md files into Markdown viewer links; without it they stay owner-files links.
 * @param {OwnerFileRoot[]} roots
 * @param {string} apiBase
 * @param {string} [viewerBase]
 */
export function createOwnerFileLinker(roots, apiBase, viewerBase) {
  const usable = roots.filter((root) => root.key && root.path.startsWith('/'));
  if (usable.length === 0) {
    /** @param {string} text */
    const plain = (text) => [{ text, href: null }];
    return { linkText: plain, linkUrl: (/** @type {string} */ url) => url };
  }
  const byPath = new Map(usable.map((root) => [root.path.replace(/\/+$/, ''), root.key]));
  const alternatives = [...byPath.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  const pattern = `(?<![\\w/.~-])(?:file://(?:localhost)?)?(?<root>${alternatives})(?![\\w-]|\\.\\w)(?<rest>(?:/[^${DELIMITERS}]*)?)`;
  /** @param {string} rootPath @param {string} rest @param {boolean} fromFileUrl */
  const hrefFor = (rootPath, rest, fromFileUrl) => {
    const segments = rest.split('/').filter(Boolean).map((/** @type {string} */ s) => (fromFileUrl ? decode(s) : s));
    if (segments.includes('..') || segments.includes('.')) return null;
    const last = segments.at(-1);
    if (viewerBase !== undefined && last !== undefined && !rest.endsWith('/') && last.toLowerCase().endsWith('.md')) {
      return `${viewerBase}/work/markdown?${new URLSearchParams({ root: /** @type {string} */ (byPath.get(rootPath)), path: segments.join('/') })}`;
    }
    const tail = segments.map(encodeURIComponent).join('/');
    return `${apiBase}/owner-files/${encodeURIComponent(/** @type {string} */ (byPath.get(rootPath)))}${tail ? `/${tail}` : ''}`;
  };

  const nextWord = new RegExp(`( )([^${DELIMITERS}]+)`, 'uy');
  const startsRoot = new RegExp(`^(?:file://(?:localhost)?)?(?:${alternatives})`, 'u');
  /**
   * Only for .md: a path whose last name has no extension may go on past single spaces up to the first word ending in ".md".
   * Text cannot tell a space inside a name from a space between words, so "dir see notes.md" is read as one path:
   * the other choices (cut at the first space, or take the whole line) break Japanese names with spaces or join two paths on one line.
   * Returns the new end index in `text`, or -1 to keep the path as matched.
   * @param {string} text @param {string} rest @param {number} from
   */
  const extendOverSpaces = (text, rest, from) => {
    if (viewerBase === undefined || rest === '' || rest.endsWith('/') || /\.md$/i.test(rest) || /** @type {string} */ (rest.split('/').at(-1)).includes('.')) return -1;
    for (let at = from; ;) {
      nextWord.lastIndex = at;
      const m = nextWord.exec(text);
      if (m === null || startsRoot.test(m[2])) return -1;
      const trimmed = m[2].replace(/\.+$/, '');
      if (/\.md$/i.test(trimmed)) return at + 1 + trimmed.length;
      if (trimmed !== m[2]) return -1;
      at += m[0].length;
    }
  };

  /**
   * Splits text into plain pieces and links, keeping every character in order.
   * @param {string} text
   * @returns {Array<{ text: string, href: string | null }>}
   */
  const linkText = (text) => {
    const pieces = [];
    let at = 0;
    for (const match of text.matchAll(new RegExp(pattern, 'gu'))) {
      const groups = /** @type {Record<string, string>} */ (match.groups);
      if (match.index < at) continue;
      let rest = groups.rest.replace(/\.+$/, '');
      let end = match.index + match[0].length - (groups.rest.length - rest.length);
      const longer = rest === groups.rest ? extendOverSpaces(text, rest, end) : -1;
      if (longer !== -1) {
        end = longer;
        rest = text.slice(match.index + match[0].length - groups.rest.length, end);
      }
      const href = hrefFor(groups.root, rest, match[0].startsWith('file:'));
      if (href === null) continue;
      if (match.index > at) pieces.push({ text: text.slice(at, match.index), href: null });
      pieces.push({ text: text.slice(match.index, end), href });
      at = end;
    }
    if (at < text.length) pieces.push({ text: text.slice(at), href: null });
    return pieces;
  };

  /** The owner-files href when the whole URL (usually file://) is inside a root, else the URL unchanged. @param {string} url */
  const linkUrl = (url) => {
    const pieces = linkText(url);
    return pieces.length === 1 && pieces[0].href !== null ? pieces[0].href : url;
  };
  return { linkText, linkUrl };
}

/** @param {string} value */
const hastText = (value) => ({ type: 'text', value });
/** @param {Array<{ text: string, href: string | null }>} pieces */
const hastPieces = (pieces) => pieces.map((p) => (p.href === null
  ? hastText(p.text)
  : { type: 'element', tagName: 'a', properties: { href: p.href }, children: [hastText(p.text)] }));

/**
 * remark plugin: turns allowed-folder paths in text, inline code, code blocks and file:// links into owner-files links.
 * @param {{ roots: OwnerFileRoot[], apiBase: string, viewerBase?: string }} options
 */
export function remarkOwnerFileLinks({ roots, apiBase, viewerBase }) {
  const { linkText, linkUrl } = createOwnerFileLinker(roots, apiBase, viewerBase);
  /** @param {any} parent */
  const convert = (parent) => {
    /** @type {any[]} */
    const out = [];
    for (const node of parent.children) {
      if (node.type === 'link') {
        node.url = linkUrl(node.url);
        out.push(node);
      } else if (node.type === 'text') {
        for (const p of linkText(node.value)) {
          out.push(p.href === null ? { type: 'text', value: p.text } : { type: 'link', url: p.href, children: [{ type: 'text', value: p.text }] });
        }
      } else if (node.type === 'inlineCode' || node.type === 'code') {
        const pieces = linkText(node.value);
        if (pieces.every((p) => p.href === null)) {
          out.push(node);
          continue;
        }
        // Markdown code nodes cannot hold links, so they are handed to hast pre-built.
        const code = { type: 'element', tagName: 'code', properties: node.lang ? { className: [`language-${node.lang}`] } : {}, children: hastPieces(pieces) };
        out.push(node.type === 'code'
          ? { type: 'ownerCode', data: { hName: 'pre', hChildren: [code] } }
          : { type: 'ownerCode', data: { hName: 'code', hChildren: code.children } });
      } else {
        if (node.children) convert(node);
        out.push(node);
      }
    }
    parent.children = out;
  };
  return (/** @type {any} */ tree) => convert(tree);
}
