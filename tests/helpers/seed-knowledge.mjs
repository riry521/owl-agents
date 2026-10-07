import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { fingerprint } from "../../packages/core/dist/learning-fingerprint.js";
import { resolveKnowledgeFilename, slugifyKnowledgeName } from "../../packages/core/dist/knowledge-naming.js";
import { parsePage, renderPage } from "../../packages/core/dist/memory/page-format.js";
import { createUlid } from "../../packages/db/dist/index.js";

const PAGES = new URL("../../packages/core/test/memory/fixtures/pages/", import.meta.url);

/** The common table of contents (`common/_index.md`) with `summary` as its overview, built from the shared sample page. */
export function commonIndexPage(summary) {
  const page = parsePage(readFileSync(new URL("project-index.md", PAGES), "utf8"));
  const { project_id: _drop, ...frontmatter } = page.frontmatter;
  return renderPage({
    ...page,
    frontmatter: { ...frontmatter, id: createUlid(), scope: "common", title: "共通の目次", source_hash: "c0".repeat(32) },
    frontmatter_order: page.frontmatter_order.filter((key) => key !== "project_id"),
    title: "共通の目次",
    sections: page.sections.map((section) => (section.heading === "概要" ? { ...section, lines: [summary] } : section)),
  });
}

/** Writes `common/_index.md` under a vault directory. */
export async function writeCommonIndex(vaultDir, summary) {
  const file = join(vaultDir, "common", "_index.md");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, commonIndexPage(summary));
  return file;
}

/**
 * Writes one note in the old `notes/` format (id, claims with fingerprints, sources) so tests of the
 * note-based Rule proposal API have a note to point at. The product no longer writes such notes.
 */
export async function seedNote(notes, { topic, kind, text, work_id, project_id = null, tags = [] }) {
  const now = new Date().toISOString().slice(0, 10);
  const id = createUlid();
  const slug = slugifyKnowledgeName(topic);
  const note = {
    id, title: topic, slug, tags: [...tags].sort(), sources: [work_id], links: [], project_ids: project_id ? [project_id] : [],
    created: now, updated: now, summary: text.slice(0, 200),
    claims: [{ fingerprint: fingerprint(text), kind, text, sources: [work_id] }], promotions: [],
  };
  await mkdir(notes.notesDir, { recursive: true });
  const resolved = await resolveKnowledgeFilename(notes.notesDir, slug);
  await notes.writeNote(resolved.filename, note);
  return { note_id: id, path: `notes/${resolved.filename}` };
}

/** `{ body, metadata }` of a valid clipping page, for tests that only need some knowledge file to exist. */
export function clip(title) {
  return {
    body: `# ${title}\n\n## 出典\n- https://example.test/a\n\n## 要点\n- ${title}\n\n## 関係する Project\n- （なし）\n`,
    metadata: { id: createUlid(), type: "clipping", title, source_url: "https://example.test/a", retrieved_at: "2026-10-04T00:00:00Z", retrieved_by: "external", summary: title },
  };
}
