/** @typedef {{ key: string, path: string }} OwnerFileRoot */

const DELIMITERS = '\\s\\u3000「」『』（）()【】［］\\[\\]{}〈〉《》<>、。，．,;；:：`\'"“”‘’*|!！?？=';
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether an href points at the owner-files route (so it must open in a new tab). */
export function isOwnerFileHref(href, apiBase) {
  return typeof href === 'string' && href.startsWith(`${apiBase}/owner-files/`);
}

/** Extra props for the <a> of an owner-files link; empty for any other link. */
export function ownerFileAnchorProps(href, apiBase) {
  return isOwnerFileHref(href, apiBase) ? { target: '_blank', rel: 'noopener noreferrer' } : {};
}

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
 * @param {OwnerFileRoot[]} roots
 */
export function createOwnerFileLinker(roots, apiBase) {
  const usable = roots.filter((root) => root.key && root.path.startsWith('/'));
  if (usable.length === 0) return { linkText: (text) => [{ text, href: null }], linkUrl: (url) => url };
  const byPath = new Map(usable.map((root) => [root.path.replace(/\/+$/, ''), root.key]));
  const alternatives = [...byPath.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  const pattern = `(?<![\\w/.~-])(?:file://(?:localhost)?)?(?<root>${alternatives})(?![\\w-]|\\.\\w)(?<rest>(?:/[^${DELIMITERS}]*)?)`;
  const hrefFor = (rootPath, rest, fromFileUrl) => {
    const segments = rest.split('/').filter(Boolean).map((s) => (fromFileUrl ? decode(s) : s));
    if (segments.includes('..') || segments.includes('.')) return null;
    const tail = segments.map(encodeURIComponent).join('/');
    return `${apiBase}/owner-files/${encodeURIComponent(byPath.get(rootPath))}${tail ? `/${tail}` : ''}`;
  };

  /** Splits text into plain pieces and links, keeping every character in order. */
  const linkText = (text) => {
    const pieces = [];
    let at = 0;
    for (const match of text.matchAll(new RegExp(pattern, 'gu'))) {
      const rest = match.groups.rest.replace(/\.+$/, '');
      const href = hrefFor(match.groups.root, rest, match[0].startsWith('file:'));
      if (href === null) continue;
      const end = match.index + match[0].length - (match.groups.rest.length - rest.length);
      if (match.index > at) pieces.push({ text: text.slice(at, match.index), href: null });
      pieces.push({ text: text.slice(match.index, end), href });
      at = end;
    }
    if (at < text.length) pieces.push({ text: text.slice(at), href: null });
    return pieces;
  };

  /** The owner-files href when the whole URL (usually file://) is inside a root, else the URL unchanged. */
  const linkUrl = (url) => {
    const pieces = linkText(url);
    return pieces.length === 1 && pieces[0].href !== null ? pieces[0].href : url;
  };
  return { linkText, linkUrl };
}

const hastText = (value) => ({ type: 'text', value });
const hastPieces = (pieces) => pieces.map((p) => (p.href === null
  ? hastText(p.text)
  : { type: 'element', tagName: 'a', properties: { href: p.href }, children: [hastText(p.text)] }));

/** remark plugin: turns allowed-folder paths in text, inline code, code blocks and file:// links into owner-files links. */
export function remarkOwnerFileLinks({ roots, apiBase }) {
  const { linkText, linkUrl } = createOwnerFileLinker(roots, apiBase);
  const convert = (parent) => {
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
  return (tree) => convert(tree);
}
