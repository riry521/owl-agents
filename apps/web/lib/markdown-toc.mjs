/** @typedef {{ id: string, text: string, level: number }} TocEntry */

/** A heading's text as a URL-safe id, unique among `used` (the id is added to it). */
export function slugifyHeading(text, used) {
  const base = text.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '') || 'section';
  let id = base;
  for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
  used.add(id);
  return id;
}

const nodeText = (node) => (typeof node.value === 'string' ? node.value : (node.children ?? []).map(nodeText).join(''));

/** Remark plugin: adds id and tabIndex to the headings directly under the root. */
export function remarkHeadingIds() {
  return (tree) => {
    const used = new Set();
    for (const node of tree.children) {
      if (node.type !== 'heading') continue;
      node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: slugifyHeading(nodeText(node), used), tabIndex: -1 } };
    }
  };
}

/**
 * The entries to show: drops a lone leading h1, indents from the shallowest level, returns [] below two.
 * @param {TocEntry[]} headings
 * @returns {Array<TocEntry & { indent: number }>}
 */
export function tocEntries(headings) {
  const loneTitle = headings[0]?.level === 1 && headings.filter((h) => h.level === 1).length === 1;
  const kept = loneTitle ? headings.slice(1) : headings;
  if (kept.length < 2) return [];
  const shallowest = Math.min(...kept.map((h) => h.level));
  return kept.map((h) => ({ ...h, indent: h.level - shallowest }));
}
