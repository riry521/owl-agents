import { createHash } from "node:crypto";
import { isAbsolute, win32 } from "node:path";

export interface SkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly scope: string;
  readonly tags: readonly string[];
}

export type ParsedSkillMd = SkillMetadata & { readonly body: string };
export type ParseSkillMdResult = ParsedSkillMd | { readonly error: string };
export type SkillFilePathResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const SKILL_FILE_DIRECTORIES = new Set(["references", "scripts", "templates"]);

export function validateSkillName(name: string): boolean {
  return typeof name === "string" && SKILL_NAME_PATTERN.test(name);
}

export function validateSkillFilePath(path: string): SkillFilePathResult {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    return { ok: false, reason: "File path must be a non-empty relative path." };
  }
  if (isAbsolute(path) || win32.isAbsolute(path) || path.startsWith("/") || path.includes("\\")) {
    return { ok: false, reason: "Absolute paths and platform-specific separators are not allowed." };
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return { ok: false, reason: "Empty and traversal path segments are not allowed." };
  }
  if (path === "SKILL.md") return { ok: true };
  if (segments.length !== 2 || !SKILL_FILE_DIRECTORIES.has(segments[0])) {
    return { ok: false, reason: "Files must be SKILL.md or directly inside references/, scripts/, or templates/." };
  }
  return { ok: true };
}

export function parseSkillMd(text: string): ParseSkillMdResult {
  if (typeof text !== "string" || text.includes("\0")) return { error: "SKILL.md must be valid text without NUL characters." };
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(text);
  if (!match) return { error: "SKILL.md frontmatter is missing or malformed." };

  const fields = new Map<string, string>();
  const tags: string[] = [];
  let readingBlockTags = false;
  for (const line of match[1].split(/\r?\n/u)) {
    const item = /^\s+-\s+(.+)\s*$/u.exec(line);
    if (readingBlockTags && item) {
      const tag = parseScalar(item[1]);
      if (tag === null) return { error: "SKILL.md contains invalid tags." };
      tags.push(tag);
      continue;
    }
    readingBlockTags = false;
    if (line.trim().length === 0) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) return { error: "SKILL.md frontmatter contains a malformed field." };
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (fields.has(key)) return { error: `SKILL.md contains duplicate ${key} metadata.` };
    if (key === "tags") {
      if (rawValue === "") {
        readingBlockTags = true;
        continue;
      }
      const parsed = parseTags(rawValue);
      if (!parsed) return { error: "SKILL.md contains invalid tags." };
      tags.push(...parsed);
      continue;
    }
    const value = parseScalar(rawValue);
    if (value === null) return { error: `SKILL.md contains invalid ${key} metadata.` };
    fields.set(key, value);
  }

  const name = fields.get("name");
  const description = fields.get("description");
  const scope = fields.get("scope");
  if (!name || !validateSkillName(name)) return { error: "SKILL.md name is invalid." };
  if (!description || description.length > 300 || /[\r\n\u0000-\u001f\u007f]/u.test(description)) {
    return { error: "SKILL.md description must be a single line of at most 300 characters." };
  }
  if (!scope || !isValidSkillScope(scope)) return { error: "SKILL.md scope is invalid." };
  if (tags.some((tag) => tag.length === 0 || /[\r\n\u0000-\u001f\u007f]/u.test(tag))) return { error: "SKILL.md contains invalid tags." };

  return {
    name,
    description,
    scope,
    tags,
    body: text.slice(match[0].length).replace(/^\r?\n/u, ""),
  };
}

export function renderSkillMd(meta: SkillMetadata, body: string): string {
  if (!validateSkillName(meta.name)) throw new TypeError("Skill name is invalid.");
  if (meta.description.length === 0 || meta.description.length > 300 || /[\r\n\u0000-\u001f\u007f]/u.test(meta.description)) {
    throw new TypeError("Skill description must be a single line of at most 300 characters.");
  }
  if (!isValidSkillScope(meta.scope)) throw new TypeError("Skill scope is invalid.");
  if (meta.tags.some((tag) => typeof tag !== "string" || tag.length === 0 || /[\r\n\u0000-\u001f\u007f]/u.test(tag))) {
    throw new TypeError("Skill tags must be non-empty single-line strings.");
  }
  if (typeof body !== "string" || body.includes("\0")) throw new TypeError("Skill body must be valid text without NUL characters.");

  return [
    "---",
    `name: ${meta.name}`,
    `description: ${JSON.stringify(meta.description)}`,
    `scope: ${JSON.stringify(meta.scope)}`,
    `tags: ${JSON.stringify(meta.tags)}`,
    "---",
    "",
    body.replace(/^\r?\n/u, ""),
  ].join("\n");
}

export function hashSkillFiles(files: Record<string, string>): string {
  const entries = Object.keys(files).sort().map((path) => [path, files[path]]);
  return createHash("sha256").update(JSON.stringify(entries), "utf8").digest("hex");
}

export function isValidSkillScope(scope: string): boolean {
  return scope === "global" || (scope.startsWith("project:") && scope.slice("project:".length).trim().length > 0 && !/[\r\n\u0000-\u001f\u007f]/u.test(scope));
}

function parseTags(raw: string): string[] | null {
  if (!raw.startsWith("[") || !raw.endsWith("]")) return null;
  const inner = raw.slice(1, -1).trim();
  if (inner.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : null;
  } catch {
    const values: string[] = [];
    let current = "";
    let quote: "'" | '"' | null = null;
    for (const character of inner) {
      if (quote) {
        current += character;
        if (character === quote) quote = null;
      } else if (character === "'" || character === '"') {
        quote = character;
        current += character;
      } else if (character === ",") {
        const value = parseScalar(current.trim());
        if (value === null) return null;
        values.push(value);
        current = "";
      } else {
        current += character;
      }
    }
    if (quote) return null;
    const value = parseScalar(current.trim());
    if (value === null) return null;
    values.push(value);
    return values;
  }
}

function parseScalar(raw: string): string | null {
  if (raw.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  if (raw.startsWith("'")) {
    return raw.endsWith("'") && raw.length >= 2 ? raw.slice(1, -1).replace(/''/gu, "'") : null;
  }
  return raw.replace(/(?:^|\s)#.*$/u, "").trim();
}
