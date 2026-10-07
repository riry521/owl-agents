import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export function slugifyKnowledgeName(value: string, fallback?: string, maxLength = 60): string {
  const slug = slugifyKnowledgeNameOrNull(value, maxLength);
  if (slug) return slug;

  const alternative = normalizeKnowledgeName(fallback ?? "") || `note-${createHash("sha1").update(value).digest("hex").slice(0, 8)}`;
  return clipKnowledgeName(alternative, maxLength);
}

export function slugifyKnowledgeNameOrNull(value: string, maxLength = 60): string | null {
  const slug = normalizeKnowledgeName(value);
  if (!slug) return null;
  return clipKnowledgeName(slug, maxLength) || null;
}

export function slugifyKnowledgeContent(value: string, prefix: string, maxLength = 60): string {
  const digest = createHash("sha1").update(value).digest("hex").slice(0, 8);
  return slugifyKnowledgeName("", `${prefix}-${digest}`, maxLength);
}

export function slugifyKnowledgeContentName(value: string, prefix: string): string {
  for (const line of value.split(/\r?\n/u)) {
    const slug = slugifyKnowledgeNameOrNull(line);
    if (slug) return slug;
  }
  return slugifyKnowledgeContent(value, prefix);
}

export function slugifyKnowledgeNameOrContent(title: string, nameFallback?: string, prefix = "note"): string {
  return slugifyKnowledgeNameOrNull(title)
    ?? slugifyKnowledgeContentName(nameFallback ?? title, prefix);
}

export async function resolveKnowledgeFilename(
  dir: string,
  slug: string,
  source?: { key: string; value: string; kind?: string; match?: Record<string, string> },
): Promise<{ filename: string; existing: boolean }> {
  const safeSlug = slugifyKnowledgeName(slug);
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") entries = [];
    else throw error;
  }

  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  if (source) {
    const candidates = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

    for (const entry of candidates) {
      let content: string;
      try {
        content = await readFile(join(dir, entry.name), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const matchesKind = source.kind === undefined
        ? !hasFrontmatterKey(content, "kind")
        : hasFrontmatterValue(content, "kind", source.kind);
      const matchesSource = hasFrontmatterValue(content, source.key, source.value)
        && Object.entries(source.match ?? {}).every(([key, value]) => hasFrontmatterValue(content, key, value));
      if (matchesKind && matchesSource) {
        return { filename: entry.name, existing: true };
      }
    }
  }

  for (let suffix = 1; ; suffix += 1) {
    const filename = `${safeSlug}${suffix === 1 ? "" : `-${suffix}`}.md`;
    if (!byName.has(filename)) return { filename, existing: false };
  }
}

function normalizeKnowledgeName(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function clipKnowledgeName(input: string, maxLength: number): string {
  return Array.from(input).slice(0, Math.max(0, Math.floor(maxLength))).join("").replace(/-+$/u, "");
}

function hasFrontmatterValue(content: string, key: string, value: string): boolean {
  return (getFrontmatterLines(content) ?? []).some((line) => {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith(`${key}:`)) return false;
    const stored = trimmed.slice(key.length + 1).trim();
    if (stored === value) return true;
    try {
      return JSON.parse(stored) === value;
    } catch {
      return false;
    }
  });
}

function hasFrontmatterKey(content: string, key: string): boolean {
  return (getFrontmatterLines(content) ?? []).some((line) => line.trimStart().startsWith(`${key}:`));
}

function getFrontmatterLines(content: string): string[] | null {
  const openingLength = content.startsWith("---\r\n") ? 5 : content.startsWith("---\n") ? 4 : 0;
  if (openingLength === 0) return null;
  const rest = content.slice(openingLength);
  const closing = /\r?\n---(?:\r?\n|$)/u.exec(rest);
  if (!closing) return null;
  return rest.slice(0, closing.index).split(/\r?\n/u);
}
