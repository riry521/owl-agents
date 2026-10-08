import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { generateUlid } from "@owl/shared";

import { fingerprint } from "./learning-fingerprint.js";
import { slugifyKnowledgeName } from "./knowledge-naming.js";
import { MAX_NOTE_TAGS, sanitizeKeywords } from "./knowledge-tags.js";
import type { KnowledgeNotes, NoteClaim, NoteDocument } from "./knowledge-notes.js";
import type { PageRouter } from "./memory/page-router.js";
import { redactResearchText } from "./research-filter.js";

const execFileAsync = promisify(execFile);

export const PROJECT_OVERVIEW_FILE_PATTERN = /^project-overview-[0-9A-HJKMNP-TV-Z]{26}\.md$/u;
export const projectOverviewFilename = (projectId: string): string => {
  const filename = `project-overview-${projectId}.md`;
  if (!PROJECT_OVERVIEW_FILE_PATTERN.test(filename)) throw new Error("invalid_project_id");
  return filename;
};

export interface ProjectSourceReader {
  /** Tracked file paths at ref, or null on failure. */
  listFiles(repo: string, ref: string): Promise<string[] | null>;
  /** UTF-8 body of a tracked file, or null when unreadable or too large. */
  readFile(repo: string, ref: string, path: string, maxBytes: number): Promise<string | null>;
  /** Paths changed between two commits, or null on failure. */
  changedPaths(repo: string, from: string, to: string): Promise<string[] | null>;
  /** Per-file added/deleted lines between two commits (null counts = binary), or null on failure. */
  diffStat?(repo: string, from: string, to: string): Promise<DiffStatEntry[] | null>;
  /** Full commit hash of ref, or null. */
  resolveCommit?(repo: string, ref: string): Promise<string | null>;
}
export interface DiffStatEntry { path: string; added: number | null; deleted: number | null }

const SECRET_SEGMENT = /^(\.env(\..*)?|secrets?\.json|.*\.secret.*|credentials.*|\.netrc|\.npmrc|\.pypirc|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa).*|\.ssh|\.aws|\.gnupg|\.git)$/iu;
export function isSecretPath(path: string): boolean {
  const segments = path.split("/");
  return segments.some((segment, index) => SECRET_SEGMENT.test(segment) || (segment === ".config" && segments[index + 1] === "gh"));
}

const ROOT_SOURCES = new Set([
  "README.ja.md", "README.md", "README", "readme.md", "package.json", "pnpm-workspace.yaml", "pyproject.toml",
  "Cargo.toml", "go.mod", "Gemfile", "composer.json", "deno.json", "Makefile", "justfile", "requirements.txt", "docker-compose.yml",
  ".nvmrc", ".node-version", ".python-version", ".tool-versions", "CLAUDE.md", "AGENTS.md",
]);
export function isOverviewSourcePath(path: string): boolean {
  if (isSecretPath(path)) return false;
  return ROOT_SOURCES.has(path) || /^(apps|packages)\/[^/]+\/package\.json$/u.test(path) || /^docs\/.+\.md$/u.test(path);
}

const SAFE_REF = /^[A-Za-z0-9._/-]{1,200}$/u;
const safeRef = (ref: string): boolean => SAFE_REF.test(ref) && !ref.startsWith("-");
const safePath = (path: string): boolean => !/[\0\n]/u.test(path) && !/^[-/]/u.test(path) && !path.split("/").includes("..");

export class GitProjectSourceReader implements ProjectSourceReader {
  public async listFiles(repo: string, ref: string): Promise<string[] | null> {
    if (!safeRef(ref)) return null;
    const out = await this.git(repo, ["ls-tree", "-r", "--name-only", "-z", ref]);
    return out === null ? null : out.split("\0").filter((path) => path && !isSecretPath(path)).slice(0, 5000);
  }

  public async readFile(repo: string, ref: string, path: string, maxBytes: number): Promise<string | null> {
    if (!safeRef(ref) || !safePath(path) || !isOverviewSourcePath(path)) return null;
    const size = Number(await this.git(repo, ["cat-file", "-s", `${ref}:${path}`]));
    if (!Number.isFinite(size) || size > maxBytes) return null;
    return this.git(repo, ["cat-file", "blob", `${ref}:${path}`]);
  }

  public async changedPaths(repo: string, from: string, to: string): Promise<string[] | null> {
    if (!safeRef(from) || !safeRef(to)) return null;
    const out = await this.git(repo, ["diff", "--name-only", "-z", from, to]);
    return out === null ? null : out.split("\0").filter((path) => path && !isSecretPath(path));
  }

  public async diffStat(repo: string, from: string, to: string): Promise<DiffStatEntry[] | null> {
    if (!safeRef(from) || !safeRef(to)) return null;
    const out = await this.git(repo, ["diff", "--numstat", "-z", "-M", from, to]);
    if (out === null) return null;
    const parts = out.split("\0");
    const entries: DiffStatEntry[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      const m = parts[i].match(/^(\d+|-)\t(\d+|-)\t(.*)$/u);
      if (!m) continue;
      const path = m[3] || parts[(i += 2)]; // a rename has an empty path, then "old\0new"
      if (path) entries.push({ path, added: m[1] === "-" ? null : Number(m[1]), deleted: m[2] === "-" ? null : Number(m[2]) });
    }
    return entries;
  }

  public async resolveCommit(repo: string, ref: string): Promise<string | null> {
    if (!safeRef(ref)) return null;
    return (await this.git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]))?.trim() || null;
  }

  private async git(repo: string, args: string[]): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("git", ["-C", repo, ...args], {
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
        timeout: 10_000,
        // Why not 1 MiB: `ls-tree -r` of a repository with ~17k paths exceeds it and the whole listing became null.
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout;
    } catch {
      return null;
    }
  }
}

export interface ProjectOverviewInput {
  readonly id: string;
  readonly name: string;
  readonly canonical_path: string;
  readonly base_branch: string;
  readonly verification_plan_json?: string | null;
}

export type ProjectOverviewTrigger =
  | { readonly kind: "project_created" }
  | {
    readonly kind: "work_completed";
    readonly work_id: string;
    readonly title: string;
    readonly merge: { readonly old_base_commit: string; readonly new_base_commit: string } | null;
  }
  | { readonly kind: "manual_investigation" };

/** Result of the injected investigation function (same shape as the runtime's output). */
export interface InvestigationItem { text: string; evidence_paths: string[] }
export interface ProjectInvestigationOutput {
  purpose: InvestigationItem;
  architecture_flow: InvestigationItem;
  entry_points: InvestigationItem;
  run_and_test: InvestigationItem;
  cautions: InvestigationItem[];
}
export interface ProjectInvestigationInput {
  project: ProjectOverviewInput;
  commit: string | null;
  reason: string;
  known_facts: { tech: string[]; commands: string[]; structure: string[]; cautions: string[] };
}
export type ProjectInvestigationResult = { ok: true; investigation: ProjectInvestigationOutput } | { ok: false; error: string };

export const INVESTIGATION_THRESHOLDS = { thinPurposeChars: 40, thinProseChars: 1000, bigFiles: 30, bigLines: 2000, bigTopLevel: 1 } as const;
/** Marks a claim written by an investigation; light refreshes carry such claims over untouched. */
export const INVESTIGATION_MARKER = /^【[^】]+】〔調査 (\d{4}-\d{2}-\d{2}) ([0-9a-f]{12}|unknown)〕/u;
export const isInvestigationClaim = (c: NoteClaim): boolean => INVESTIGATION_MARKER.test(c.text);
const LOCKFILES = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "Cargo.lock", "poetry.lock", "uv.lock", "go.sum"]);
const topLevelDirs = (files: string[]): Set<string> => new Set(files.flatMap((path) => {
  const seg = path.split("/");
  if (seg.length < 2 || seg[0].startsWith(".")) return [];
  return seg.length > 2 && (seg[0] === "apps" || seg[0] === "packages") ? [seg[0], `${seg[0]}/${seg[1]}`] : [seg[0]];
}));

/** Size of a merge, ignoring lockfiles and secret paths; big = any threshold reached. */
export function measureChange(entries: DiffStatEntry[], oldFiles: string[], newFiles: string[]): { files: number; lines: number; topLevelChanged: string[]; big: boolean } {
  const used = entries.filter((e) => !isSecretPath(e.path) && !LOCKFILES.has(e.path.split("/").pop() ?? ""));
  const files = used.length;
  const lines = used.reduce((sum, e) => sum + (e.added ?? 0) + (e.deleted ?? 0), 0);
  const before = topLevelDirs(oldFiles);
  const after = topLevelDirs(newFiles);
  const topLevelChanged = [...after].filter((d) => !before.has(d)).concat([...before].filter((d) => !after.has(d)));
  const t = INVESTIGATION_THRESHOLDS;
  return { files, lines, topLevelChanged, big: files >= t.bigFiles || lines >= t.bigLines || topLevelChanged.length >= t.bigTopLevel };
}

export interface ProjectOverviewServiceOptions {
  readonly notes: Pick<KnowledgeNotes, "upsertFixedFile"> & Partial<Pick<KnowledgeNotes, "getProjectOverview">>;
  /** Optional read-only investigation of the repository; only called for project_created, thin docs, big merges and manual requests. */
  readonly investigate?: (input: ProjectInvestigationInput) => Promise<ProjectInvestigationResult>;
  /** Told whether an ok result was usable, so the caller's failure history stays honest. */
  readonly onInvestigated?: (projectId: string, valid: boolean) => void;
  readonly withWrite: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly getProject: (projectId: string) => ProjectOverviewInput | null;
  readonly reader: ProjectSourceReader;
  /** Optional provider hook that summarizes the purpose in Japanese; null or a throw falls back to the fixed template. */
  readonly describe?: (source: string) => Promise<string | null>;
  /** Fixed Japanese purpose per project (bulk script's --purpose-file); wins over everything else. */
  readonly purposeOf?: (projectId: string) => string | undefined;
  readonly now?: () => string;
  readonly log?: (message: string, error: unknown) => void;
  /** With `pages` set the overview goes into the Project's プロジェクトの構成 page instead of the fixed note. */
  readonly pages?: { readonly router: Pick<PageRouter, "readOverview" | "writeOverview"> };
}

const LABELS = ["【目的】", "【技術スタック】", "【主要コマンド】", "【構成】", "【注意】", "【最近の変更】"] as const;
const MAX_RECENT = 5;
const MAX_FILE_BYTES = 64 * 1024;
const TECH_SIGNALS: ReadonlyArray<readonly [string, string]> = [
  ["typescript", "TypeScript"], ["next", "Next.js"], ["react", "React"], ["vue", "Vue"], ["express", "Express"],
  ["better-sqlite3", "SQLite"], ["vite", "Vite"], ["tailwindcss", "Tailwind CSS"], ["playwright", "Playwright"],
];
const JAPANESE = /[぀-ヿ一-鿿]/u;
const SECRET_LINE = /-----BEGIN|gh[pousr]_|github_pat_|\bsk-|xox[abp]-|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{20,}/u;
const SENSITIVE_WORDS = /secret|\.env|auth\.json|token|passw|api[ _-]?key|キー|トークン|パスワード|認証/iu;
const EXT_TECH: ReadonlyArray<readonly [string, string]> = [
  ["py", "Python"], ["ts", "TypeScript"], ["tsx", "TypeScript"], ["js", "JavaScript"], ["mjs", "JavaScript"], ["rs", "Rust"],
  ["go", "Go"], ["rb", "Ruby"], ["php", "PHP"], ["sh", "シェルスクリプト"],
];
const PY_SIGNALS: ReadonlyArray<readonly [string, string]> = [
  ["fastapi", "FastAPI"], ["django", "Django"], ["flask", "Flask"], ["streamlit", "Streamlit"], ["pytest", "pytest"],
  ["pandas", "pandas"], ["torch", "PyTorch"], ["lightgbm", "LightGBM"], ["pydantic", "Pydantic"],
];
const COMMAND_LINE = /^(?:\$ )?((?:pnpm|npm|yarn|python3?|pip3?|make|docker|cargo|go|node|uv|npx|just)\s.+)$/u;

const BOUNDARY = /[。！？]|\n|\.(?=\s|$)/gu;
const CJK = "[\\u3000-\\u9fff\\uff00-\\uffef]";
const normalize = (text: string): string => text.replace(/\s+/gu, " ").replace(new RegExp(`(?<=${CJK}) (?=${CJK})`, "gu"), "").trim();
/** Cuts at a sentence boundary found before whitespace is normalized. whole: keep only complete sentences (the longest prefix within max ending at 。！？, a newline or an English period; "" when there is none). */
const cutSentence = (text: string, max: number, whole = false): string => {
  const flat = normalize(text);
  if (!whole && flat.length <= max) return flat;
  const ends = [...text.matchAll(BOUNDARY)].map((m) => (m[0] === "\n" ? m.index : m.index + 1)).filter((end) => normalize(text.slice(0, end)).length <= max);
  return ends.length ? normalize(text.slice(0, ends[ends.length - 1])) : "";
};
const clean = (text: string, max: number, whole = false): string => {
  const redacted = redactResearchText(text).text;
  return SECRET_LINE.test(redacted) ? "" : cutSentence(redacted, max, whole);
};
const CAUTION_PREFIX = /^(?:(?:(?:注意|重要|警告|Note|Important)\s*[:：]|※)\s*)+/iu;
/** Log lines, work reports, option choices and table fragments are not lasting cautions. */
const TRANSIENT = /\b(?:WARN|WARNING|ERROR|FATAL)\b|\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}|案[A-Z]|選択肢|採用|(?:^|[\s、])[A-Z]\s*は|\|.*\|/u;
/** A work report is judged per sentence, so a report followed by more sentences is still caught. */
const isReport = (text: string): boolean => text.split(/(?<=[。！？])/u).some((sentence) => /した[。.！？]?\s*$/u.test(sentence));
/** "label: noun、noun、noun" describes features (禁止ワード検出 etc.) unless the label or body is itself a caution: a caution label, a directive, or 禁止 used on its own rather than inside a compound noun. */
const isFeatureList = (text: string): boolean => {
  const [, label, body] = text.match(/^([^:：。]{1,20})[:：]\s*([^。]+)$/u) ?? [];
  if (body === undefined || /注意|禁止|重要|警告|Note|Important|ルール|制約/iu.test(label)) return false;
  return body.split("、").length >= 3 && !/禁止(?![ァ-ヶ一-龠])|しない|してはならない|必ず|厳禁|\bNG\b|must|never|do not|don't/iu.test(body);
};
const claim = (kind: NoteClaim["kind"], text: string, sources: readonly string[] = []): NoteClaim => ({ fingerprint: fingerprint(text), kind, text, sources });

export interface Facts {
  purpose: string;
  /** True when purpose is the fixed template (no Japanese source); an existing purpose is then kept. */
  fallback?: boolean;
  /** Raw README/description text; only input for the describe hook, never written as is unless Japanese. */
  source: string;
  /** First Japanese paragraph from README, description, CLAUDE.md/AGENTS.md or docs. */
  japanese: string;
  readmeTitle: string;
  headings: string[];
  hasReadme: boolean;
  tech: string[];
  commands: string[];
  structure: string[];
  cautions: string[];
  /** The boilerplate "no cautions found" lines inside cautions; dropped when an investigation supplies cautions. */
  defaultCautions: string[];
  /** Tracked files at ref (evidence paths of an investigation must be among them). */
  files: string[];
  /** Which of README / CLAUDE.md / AGENTS.md exist, and the non-structural characters in them. */
  docs: boolean[];
  proseChars: number;
  /** purposeOf gave a fixed purpose. */
  fixed?: boolean;
}

/** Characters of running text: front matter, fenced code, headings, tables, HTML and badge lines are not counted. */
const proseLength = (text: string): number => text.replace(/^---\n[\s\S]*?\n---[ \t]*(?:\n|$)/u, "").replace(/^\s*(`{3,}|~{3,})[\s\S]*?^\s*\1.*$/gmu, "")
  .split("\n").filter((line) => !/^\s*(#|\||<|!\[|\[!\[)/u.test(line)).join("").replace(/\s/gu, "").length;

const WORK_RECORD = /^(?:実施日|設計書|作業記録|作業日|参照)\s*[:：]|取得(?:に)?失敗|取得できな|failed to (?:fetch|get)|^[\d\s\-/.:年月日T]+$/iu;
/** A paragraph that says what the project does: not a work record, a date, a bare path, a tech list or a fetch failure. */
function isPurposeText(text: string): boolean {
  if (WORK_RECORD.test(text)) return false;
  const rest = text.replace(/`[^`]*`|\S*\/\S*|\S+\.(?:md|json|ya?ml|ts|mjs|py)\b/gu, "").trim();
  if (JAPANESE.test(rest)) return rest.length >= 12 && /[はをがでにの]/u.test(rest) && /[。.]|です|ます|ツール|システム/u.test(rest);
  return rest.split(/\s+/u).length >= 4;
}

function purposeParagraphs(text: string): string[] {
  return text.replace(/^---\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/u, "\n").replace(/^```[\s\S]*?^```/gmu, "").split(/\n\s*\n/u).map((block) => block.trim()).filter((block) => block && !/^(#|```|<|!\[|\[!\[|\||[-*] )/u.test(block) && isPurposeText(block));
}
const firstParagraph = (text: string): string => purposeParagraphs(text)[0] ?? "";

export async function collectFacts(project: ProjectOverviewInput, reader: ProjectSourceReader, ref: string): Promise<Facts> {
  const repo = project.canonical_path;
  const listed = await reader.listFiles(repo, ref);
  const files = listed?.filter((path) => !isSecretPath(path)) ?? [];
  const read = async (path: string): Promise<string | null> => (isOverviewSourcePath(path) ? (await reader.readFile(repo, ref, path, MAX_FILE_BYTES))?.replace(/\r\n?/gu, "\n") ?? null : null);
  const has = (path: string): boolean => files.includes(path);
  const readme = ["README.ja.md", "README.md", "README", "readme.md"].find(has);
  const facts: Facts = { purpose: "", source: "", japanese: "", readmeTitle: "", headings: [], hasReadme: Boolean(readme), tech: [], commands: [], structure: [], cautions: [], defaultCautions: [], files, docs: [], proseChars: 0 };
  const readmeText = readme ? (await read(readme)) ?? "" : "";
  let pkg: Record<string, unknown> = {};
  const pkgText = has("package.json") ? await read("package.json") : null;
  try {
    const parsed: unknown = pkgText ? JSON.parse(pkgText) : null;
    if (parsed !== null && typeof parsed === "object") pkg = parsed as Record<string, unknown>;
  } catch { /* ignore an unparsable package.json */ }
  const deps = new Set(Object.keys({ ...(pkg.dependencies as object | undefined), ...(pkg.devDependencies as object | undefined) }));
  const manager = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : has("pnpm-workspace.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
  if (pkgText) facts.tech.push("Node.js", manager);
  for (const [dep, label] of TECH_SIGNALS) if (deps.has(dep)) facts.tech.push(label);
  for (const [file, label] of [["pyproject.toml", "Python"], ["Cargo.toml", "Rust"], ["go.mod", "Go"], ["Gemfile", "Ruby"], ["composer.json", "PHP"], ["docker-compose.yml", "Docker Compose"], ["Makefile", "Make"], ["justfile", "just"]] as const) if (has(file)) facts.tech.push(label);
  const extensions = new Set(files.map((path) => path.split(".").pop() ?? ""));
  for (const [ext, label] of EXT_TECH) if (extensions.has(ext)) facts.tech.push(label);
  const requirements = has("requirements.txt") ? (await read("requirements.txt")) ?? "" : "";
  const pyproject = has("pyproject.toml") ? (await read("pyproject.toml")) ?? "" : "";
  const pyDeps = `${requirements}\n${pyproject}`.toLowerCase();
  for (const [dep, label] of PY_SIGNALS) if (new RegExp(`(^|[^a-z0-9_-])${dep}($|[^a-z0-9_-])`, "mu").test(pyDeps)) facts.tech.push(label);
  const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
  for (const key of ["build", "dev", "start", "test", "lint", "typecheck", "format"]) {
    if (typeof scripts[key] === "string") facts.commands.push(`${manager} ${key}（${clean(scripts[key], 80)}）`);
  }
  for (const [file, pattern, tool] of [["Makefile", /^([A-Za-z][\w-]*)\s*:(?!=)/gmu, "make"], ["justfile", /^([A-Za-z][\w-]*)[^:=\n]*:(?!=)/gmu, "just"]] as const) {
    if (!has(file)) continue;
    for (const match of [...((await read(file)) ?? "").matchAll(pattern)].slice(0, 5)) facts.commands.push(`${tool} ${match[1]}`);
  }
  if (requirements) facts.commands.push("pip install -r requirements.txt");
  if (pyproject) facts.commands.push("pip install -e .");
  if (extensions.has("py") && (has("tests") || files.some((path) => path.startsWith("tests/")) || /pytest/u.test(pyDeps))) facts.commands.push("pytest");
  for (const entry of files.filter((path) => /^(cli|main|app|launcher|manage)\.py$/u.test(path))) facts.commands.push(`python ${entry}`);
  if (has("Cargo.toml")) facts.commands.push("cargo build", "cargo test");
  if (has("go.mod")) facts.commands.push("go build ./...", "go test ./...");
  if (has("Gemfile")) facts.commands.push("bundle install");
  if (has("composer.json")) facts.commands.push("composer install");
  if (has("docker-compose.yml")) facts.commands.push("docker compose up");
  let inFence = false;
  for (const line of readmeText.split("\n")) {
    if (/^\s*```/u.test(line)) { inFence = !inFence; continue; }
    const command = inFence ? line.trim().match(COMMAND_LINE)?.[1] : undefined;
    if (command) facts.commands.push(clean(command, 80));
  }
  facts.commands = [...new Set(facts.commands.filter(Boolean))].slice(0, 9);
  try {
    for (const entry of JSON.parse(project.verification_plan_json ?? "[]") as Array<{ argv?: string[] }>) {
      if (Array.isArray(entry.argv) && facts.commands.length < 9) facts.commands.push(`Owl の検証コマンド: ${clean(entry.argv.join(" "), 80)}`);
    }
  } catch { /* ignore an unparsable plan */ }
  const description = typeof pkg.description === "string" ? pkg.description : "";
  facts.source = clean(firstParagraph(readmeText) || (isPurposeText(description) ? description : ""), 300);
  facts.readmeTitle = clean(readmeText.match(/^# (.+)$/mu)?.[1] ?? "", 60);
  facts.headings = [...readmeText.matchAll(/^## (.+)$/gmu)].map((m) => clean(m[1], 30)).filter(Boolean).slice(0, 5);
  const docs = files.filter((path) => /^docs\/.+\.md$/u.test(path)).slice(0, 5);
  const topDirs = [...new Set(files.filter((path) => path.includes("/")).map((path) => path.split("/")[0]).filter((dir) => !dir.startsWith(".")))];
  facts.structure = (topDirs.length ? topDirs : files.filter((path) => !path.startsWith("."))).slice(0, 12);
  const bodies = [readmeText];
  for (const path of ["CLAUDE.md", "AGENTS.md", ...docs]) if (has(path)) bodies.push((await read(path)) ?? "");
  for (const text of bodies) {
    let fence = "";
    let blank = true;
    let code = false;
    let inList = false;
    let front = text.startsWith("---\n");
    for (const [index, line] of text.split("\n").entries()) {
      if (front) { if (index > 0 && /^(?:---|\.\.\.)\s*$/u.test(line)) { front = false; blank = true; } continue; }
      if (!line.trim()) { blank = true; continue; }
      const indented = /^(?: {4,}|\t)/u.test(line);
      const afterBlank = blank;
      blank = false;
      if (!fence && indented && (code || (afterBlank && !inList))) { code = true; continue; }
      code = false;
      const mark = line.match(/^\s*(`{3,}|~{3,})(.*)$/u);
      if (mark && !fence) { fence = mark[1]; continue; }
      if (mark && fence && mark[1][0] === fence[0] && mark[1].length >= fence.length && !mark[2].trim()) { fence = ""; continue; }
      const item = fence ? undefined : line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/u)?.[1];
      if (!fence) inList = item !== undefined || (indented && inList);
      const plain = item?.replace(/\*\*/gu, "").trim();
      const headingOnly = item !== undefined && (/^\*\*[^*]*\*\*$/u.test(item.trim()) && !/[。．.！!？?]$/u.test(plain ?? "") && !/禁止(?!事項)|してはならない|しない|必須|必ず|厳禁|\bNG\b|must|never|do not|don't/iu.test(plain ?? "") || /[:：]$/u.test(plain ?? ""));
      if (plain && !headingOnly && JAPANESE.test(plain) && !SENSITIVE_WORDS.test(plain) && !TRANSIENT.test(plain) && !isReport(plain) && !isFeatureList(plain) && /注意|禁止|必ず|重要|Do not|Never|Must|Important/iu.test(plain)) facts.cautions.push(clean(`${plain.replace(CAUTION_PREFIX, "")}\n`, 160, true));
    }
  }
  const ruleId = (text: string): string | undefined => text.match(/^I\d+(?=\s*[:：])/u)?.[0];
  const all = [...new Set(facts.cautions.filter(Boolean))];
  /** The same rule id written twice keeps the longer (more complete) wording. */
  facts.cautions = all.filter((text) => { const id = ruleId(text); return !id || text === all.filter((o) => ruleId(o) === id).reduce((a, b) => (b.length > a.length ? b : a)); }).slice(0, 6);
  if (!facts.cautions.length) {
    const guides = ["CLAUDE.md", "AGENTS.md"].filter(has);
    facts.cautions.push(guides.length
      ? `運用ルールは ${guides.join("・")} に記載されている。作業前に読む`
      : "CLAUDE.md・AGENTS.md が無く、README・docs にも注意書きが見つからなかった。変更前に README と git log を確認する");
    facts.defaultCautions = [...facts.cautions];
  }
  facts.docs = [Boolean(readme), has("CLAUDE.md"), has("AGENTS.md")];
  facts.proseChars = bodies.slice(0, 1 + ["CLAUDE.md", "AGENTS.md"].filter(has).length).reduce((sum, text) => sum + proseLength(text), 0);
  if (listed === null) facts.cautions.unshift("git からファイル一覧を取得できなかった（ブランチが無い等）。情報が不足している可能性がある");
  for (const text of [...bodies.slice(0, 1 + ["CLAUDE.md", "AGENTS.md"].filter(has).length).flatMap(purposeParagraphs),...(isPurposeText(description) ? [description] : [])]) {
    const paragraph = clean(text, 300, true);
    if (!facts.japanese && JAPANESE.test(paragraph)) facts.japanese = paragraph;
  }
  return facts;
}

/** Japanese purpose line: Japanese source is used as is; otherwise the injected describe hook or a fixed template. English source is never copied. */
async function composePurpose(project: ProjectOverviewInput, facts: Facts, describe: ProjectOverviewServiceOptions["describe"]): Promise<string> {
  if (facts.japanese) return facts.japanese;
  facts.fallback = true;
  if (facts.source && describe) {
    try {
      const text = clean((await describe(facts.source)) ?? "", 300, true);
      if (JAPANESE.test(text)) { facts.fallback = false; return text; }
    } catch { /* fall back to the fixed template */ }
  }
  const tech = [...new Set(facts.tech)].slice(0, 5).join("・");
  const base = `${project.name}は${tech ? `${tech}を使う` : ""}プロジェクト`;
  if (!facts.hasReadme) return `${base}（リポジトリに README が無く、日本語の説明文も無いため目的は構成から推定した）`;
  const title = facts.readmeTitle ? `README の題名は「${facts.readmeTitle}」` : "README に題名が無い";
  const parts = facts.headings.length ? `、主な節は${facts.headings.map((h) => `「${h}」`).join("")}` : "";
  return `${base}（${title}${parts}。README が日本語ではないため本文は転記しない）`;
}

export function buildProjectOverviewNote(input: {
  project: ProjectOverviewInput;
  facts: Facts;
  existing: NoteDocument | null;
  recentChange: { work_id: string; text: string } | null;
  now: string;
  /** Fresh investigation claims; they replace the existing ones. Without them the existing ones are carried over as they are. */
  investigation?: NoteClaim[] | null;
}): NoteDocument {
  const { project, facts, existing, recentChange, now } = input;
  const title = `プロジェクト概要: ${project.name.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim()}`.slice(0, 120).trim();
  const tech = [...new Set(facts.tech)].slice(0, 8);
  const inv = input.investigation ?? existing?.claims.filter(isInvestigationClaim) ?? [];
  const invOf = (index: number): NoteClaim[] => inv.filter((c) => c.text.startsWith(LABELS[index]));
  const invBody = (c: NoteClaim | undefined): string => c?.text.replace(INVESTIGATION_MARKER, "").replace(/（根拠:[^）]*）$/u, "") ?? "";
  const invPurpose = facts.fixed ? undefined : invOf(0)[0];
  const invCautions = invOf(4);
  const ruleCautions = facts.cautions.filter((text) => !(invCautions.length && facts.defaultCautions.includes(text))).map((text) => claim("pitfall", `${LABELS[4]}${text}`));
  const cautionClaims = invCautions.length ? [...invCautions, ...ruleCautions].slice(0, 6) : ruleCautions;
  const keptPurpose = facts.fallback ? existing?.claims.find((c) => !isInvestigationClaim(c) && c.text.startsWith(LABELS[0]))?.text.slice(LABELS[0].length) : undefined;
  if (keptPurpose !== undefined) facts.purpose = cutSentence(keptPurpose, 300, true);
  const label = (index: number, body: string): NoteClaim => claim("fact", `${LABELS[index]}${body}`);
  const recent = [
    ...(recentChange ? [claim("fact", `${LABELS[5]}${recentChange.text}`, [recentChange.work_id])] : []),
    ...(existing?.claims.filter((c) => c.text.startsWith(LABELS[5])) ?? []),
  ].slice(0, MAX_RECENT);
  const kept = existing?.claims.filter((c) => !LABELS.some((l) => c.text.startsWith(l))) ?? [];
  const purposeClaims = invPurpose ? [invPurpose] : facts.purpose ? [label(0, facts.purpose)] : [];
  const techClaim = label(1, tech.join(" / ") || "リポジトリに package.json・pyproject.toml・Cargo.toml・go.mod が無く、拡張子からも言語を判定できなかった");
  const commandText = facts.commands.join("; ") || (invOf(2).length ? "" : "リポジトリに package.json・Makefile・justfile・pyproject.toml・Cargo.toml・go.mod が無く、README にもコマンド記載が無い");
  const commandClaims = commandText ? [label(2, commandText)] : [];
  const structureClaim = label(3, `${project.canonical_path}（ベースブランチ ${project.base_branch}）。主なディレクトリ・ファイル: ${facts.structure.join(", ") || "追跡中のファイルが無い（空のリポジトリか取得失敗）"}`);
  const cautionOut = cautionClaims.length ? cautionClaims : [label(4, "注意書きは見つからなかった")];
  // Investigated claims go up front: the injection budget cuts from the tail.
  const claims = [
    ...(inv.length
      ? [...purposeClaims, structureClaim, ...invOf(3), ...invOf(2), ...cautionOut, techClaim, ...commandClaims]
      : [...purposeClaims, techClaim, ...commandClaims, structureClaim, ...cautionOut]),
    ...recent,
    ...kept,
  ].filter((c, index, all) => all.findIndex((other) => other.fingerprint === c.fingerprint) === index);
  const sentence = (text: string): string => (text && !/[。！？.]$/u.test(text) ? `${text}。` : text);
  const prefix = `${project.name}: `;
  const purposePart = cutSentence(sentence(`${prefix}${invPurpose ? invBody(invPurpose) : facts.purpose}`), 120, true);
  const flowPart = invOf(3).length ? cutSentence(sentence(`流れ: ${invBody(invOf(3)[0])}`), 100, true) : "";
  const cautionPart = cutSentence(sentence(`注意: ${invCautions.length ? invBody(invCautions[0]) : facts.cautions[0] ?? "なし"}`), 60, true);
  const parts = [
    purposePart.length > prefix.trim().length ? purposePart : "",
    flowPart.length > 3 ? flowPart : "",
    tech.length ? `技術: ${tech.slice(0, 5).join(" / ")}。` : "",
    facts.structure.length ? `構成: ${facts.structure.slice(0, 6).join(", ")}。` : "",
    facts.commands.length ? `コマンド: ${facts.commands.slice(0, 3).map((c) => c.split("（")[0]).join(", ")}。` : "",
    cautionPart.length > 3 ? cautionPart : "",
  ].map((part) => part.replace(/\s+/gu, " ").trim());
  let summary = "";
  for (const part of parts) if (part && summary.length + part.length <= 360) summary += part;
  const sources = [...new Set([...(existing?.sources ?? []), ...(recentChange ? [recentChange.work_id] : [])])].sort().slice(-50);
  return {
    id: existing?.id ?? generateUlid(),
    title,
    slug: slugifyKnowledgeName(title),
    tags: sanitizeKeywords(["project-overview", ...tech]).slice(0, MAX_NOTE_TAGS),
    sources,
    links: existing?.links ?? [],
    project_ids: [project.id],
    created: existing?.created ?? now,
    updated: now,
    summary,
    claims,
    promotions: existing?.promotions ?? [],
  };
}

/** Labelled, marked claims from an investigation. The runtime already checked each value (length, Japanese, secrets, absolute paths); only evidence that is not a tracked file is dropped here. Null when too little is left. */
function investigationClaims(out: ProjectInvestigationOutput, facts: Facts, date: string, commit: string | null): NoteClaim[] | null {
  const tag = `〔調査 ${date} ${commit && /^[0-9a-f]{12}/u.test(commit) ? commit.slice(0, 12) : "unknown"}〕`;
  const evidence = (item: InvestigationItem): string[] => [...new Set(item.evidence_paths.map((p) => p.trim().replace(/^\.\//u, "").replace(/\/$/u, "")).filter((p) => p && !isSecretPath(p)
    && (facts.files.includes(p) || facts.files.some((f) => f.startsWith(`${p}/`)))))];
  const make = (index: number, kind: NoteClaim["kind"], item: InvestigationItem | undefined): NoteClaim | null => {
    if (!item) return null;
    const text = item.text.trim().replace(/〔/gu, "（").replace(/〕/gu, "）");
    const paths = evidence(item);
    return text && paths.length ? claim(kind, `${LABELS[index]}${tag}${text}（根拠: ${paths.join(", ")}）`) : null;
  };
  const required = [make(0, "fact", out.purpose), make(3, "fact", out.architecture_flow), make(3, "fact", out.entry_points), make(2, "fact", out.run_and_test)];
  const cautions = (out.cautions ?? []).map((item) => make(4, "pitfall", item)).filter((c): c is NoteClaim => c !== null);
  return required.every((c) => c !== null) ?[...required, ...cautions] : null;
}

const sameContent = (a: NoteDocument, b: NoteDocument): boolean => JSON.stringify({ ...a, updated: "" }) === JSON.stringify({ ...b, updated: "" });

/** The thin-documentation triggers (T-a..T-d), shared by the service and Core's dry run. */
export function thinReasons(facts: Facts): string[] {
  const t = INVESTIGATION_THRESHOLDS;
  return [!facts.docs.some(Boolean) && "T-a", (facts.fixed ? facts.purpose : facts.japanese).length < t.thinPurposeChars && "T-b", facts.proseChars < t.thinProseChars && "T-c", !facts.commands.length && "T-d"].filter((r): r is string => Boolean(r));
}
/** The measurements behind thinReasons. */
export const thinMetrics = (facts: Facts) => ({ docs: facts.docs, prose_chars: facts.proseChars, purpose_chars: (facts.fixed ? facts.purpose : facts.japanese).length, commands: facts.commands.length, tracked_files: facts.files.length });

/** Best-effort creation and refresh of one overview note per project. */
export class ProjectOverviewService {
  private readonly chains = new Map<string, Promise<unknown>>();
  private pending: Promise<void> = Promise.resolve();
  private readonly now: () => string;

  public constructor(private readonly options: ProjectOverviewServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Never throws and is never awaited by callers; failures are only logged. */
  public schedule(projectId: string, trigger: ProjectOverviewTrigger): void {
    const run = this.refresh(projectId, trigger).then(() => undefined, (error) => this.options.log?.(`project overview ${projectId} failed`, error));
    this.pending = Promise.all([this.pending, run]).then(() => undefined);
  }

  public idle(): Promise<void> {
    return this.pending;
  }

  /** Serialized per project so concurrent triggers never write the same note at once. */
  public refresh(projectId: string, trigger: ProjectOverviewTrigger): Promise<"written" | "unchanged" | "skipped"> {
    const previous = this.chains.get(projectId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.run(projectId, trigger));
    this.chains.set(projectId, next);
    return next;
  }

  /** Manual re-investigation (ignores the thin/big-change conditions and the daily limit). */
  public reinvestigate(projectId: string): Promise<"written" | "unchanged" | "skipped"> {
    return this.refresh(projectId, { kind: "manual_investigation" });
  }

  /** Investigation claims for a trigger that warrants one, or null (no investigator, no reason, or it failed: the rule-based note is written). */
  private async investigate(project: ProjectOverviewInput, trigger: ProjectOverviewTrigger, facts: Facts, ref: string): Promise<NoteClaim[] | null> {
    const { investigate, reader } = this.options;
    if (!investigate) return null;
    const today = this.now().slice(0, 10);
    const manual = trigger.kind === "manual_investigation";
    let existing: NoteDocument | null = null;
    try { existing = await this.existingNote(project.id); } catch { /* treat as no existing note */ }
    const done = existing?.claims.map((c) => c.text.match(INVESTIGATION_MARKER)).find(Boolean);
    let reason = manual ? "manual" : "";
    if (!reason && !done && facts.files.length) {
      const thin = thinReasons(facts);
      reason = trigger.kind === "project_created" ? "project_created" : thin.length ? `thin:${thin.join(",")}` : "";
    }
    if (!reason && trigger.kind === "work_completed" && trigger.merge) {
      const { old_base_commit: from, new_base_commit: to } = trigger.merge;
      const entries = await reader.diffStat?.(project.canonical_path, from, to);
      const change = entries ? measureChange(entries, (await reader.listFiles(project.canonical_path, from)) ?? [], facts.files) : null;
      if (change?.big) reason = `big_change:files=${change.files},lines=${change.lines}`;
    }
    if (!reason) return null;
    let failure: unknown;
    try {
      const commit = (await reader.resolveCommit?.(project.canonical_path, ref)) ?? null;
      const result = await investigate({ project, commit, reason, known_facts: { tech: facts.tech, commands: facts.commands, structure: facts.structure, cautions: facts.cautions } });
      if (result.ok) {
        const claims = investigationClaims(result.investigation, facts, today, commit);
        this.options.onInvestigated?.(project.id, claims !== null);
        if (claims) return claims;
        failure = "insufficient_output";
      } else failure = result.error;
    } catch (error) {
      failure = error;
    }
    this.options.log?.(`project overview ${project.id} investigation failed`, failure);
    return null;
  }

  /** The current overview: the fixed note, or in pages mode the page's 【…】 lines read back as claims. */
  private async existingNote(projectId: string): Promise<NoteDocument | null> {
    const { pages, notes } = this.options;
    if (!pages) return (await notes.getProjectOverview?.(projectId)) ?? null;
    const lines = await pages.router.readOverview(projectId);
    if (lines.length === 0) return null;
    const now = this.now();
    return {
      id: generateUlid(), title: "", slug: "", tags: [], sources: [], links: [], project_ids: [projectId], created: now, updated: now, summary: "", promotions: [],
      claims: lines.map((text) => claim(text.startsWith(LABELS[4]) ? "pitfall" : "fact", text)),
    };
  }

  private async run(projectId: string, trigger: ProjectOverviewTrigger): Promise<"written" | "unchanged" | "skipped"> {
    const project = this.options.getProject(projectId);
    if (!project) return "skipped";
    const merge = trigger.kind === "work_completed" ? trigger.merge : null;
    const facts = await collectFacts(project, this.options.reader, merge?.new_base_commit ?? project.base_branch);
    const fixed = this.options.purposeOf?.(projectId);
    facts.fixed = Boolean(fixed);
    facts.purpose = fixed ? clean(fixed, 300, true) : await composePurpose(project, facts, this.options.describe);
    let recentChange: { work_id: string; text: string } | null = null;
    if (trigger.kind === "work_completed") {
      const changed = merge ? await this.options.reader.changedPaths(project.canonical_path, merge.old_base_commit, merge.new_base_commit) : null;
      const counts = new Map<string, number>();
      for (const path of (changed ?? []).filter((item) => !isSecretPath(item))) {
        const area = path.split("/").slice(0, 2).join("/");
        counts.set(area, (counts.get(area) ?? 0) + 1);
      }
      const areas = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([area]) => area);
      const text = `${this.now().slice(0, 10)} ${clean(trigger.title, 120)}${areas.length ? `（変更: ${areas.join(", ")}）` : ""}`;
      recentChange = { work_id: trigger.work_id, text };
    }
    const investigation = await this.investigate(project, trigger, facts, merge?.new_base_commit ?? project.base_branch);
    const now = this.now();
    const { pages } = this.options;
    if (pages) {
      const note = buildProjectOverviewNote({ project, facts, existing: await this.existingNote(projectId), recentChange: null, now, investigation });
      const texts = (...labels: string[]): string[] => labels.flatMap((label) => note.claims.filter((c) => c.text.startsWith(label)).map((c) => c.text));
      const written = await pages.router.writeOverview({
        project_id: projectId, overview: texts(LABELS[0]), procedure: texts(LABELS[3], LABELS[2]), pitfalls: texts(LABELS[4]),
      });
      return written ? "written" : "unchanged";
    }
    const result = await this.options.withWrite(() => this.options.notes.upsertFixedFile(projectOverviewFilename(projectId), (existing) => {
      const note = buildProjectOverviewNote({ project, facts, existing, recentChange, now, investigation });
      return existing && sameContent(existing, note) ? null : note;
    }));
    return result?.written ? "written" : "unchanged";
  }
}
