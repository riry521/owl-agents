import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Where the resolved clone root is remembered, inside the data directory. */
const REMEMBERED_FILE = "clone-root.json";
/** Folder under the data directory used when neither ghq.root nor a home folder of clones exists. */
const FALLBACK_DIRNAME = "clones";
const MIN_CLONES = 2;

export type GitConfigReader = (key: string) => Promise<string | null>;

export interface CloneRootInput {
  readonly home: string;
  readonly dataDir: string;
  /** Folders that must never be chosen (Owl's worktree roots); the data directory is always excluded. */
  readonly exclude?: readonly string[];
  /** Canonical paths of the Projects registered in Owl; their clones do not count as candidates. */
  readonly projectPaths: readonly string[];
  /** Owl's own folder outside every repository; its clones folder is the last resort when the data directory lies inside a Project. */
  readonly ownDir?: string;
  readonly gitConfig?: GitConfigReader;
  readonly env?: NodeJS.ProcessEnv;
}

export const readGitConfig = (env: NodeJS.ProcessEnv = process.env, dir?: string): GitConfigReader => (key) =>
  new Promise((done) => {
    execFile("git", [...(dir === undefined ? [] : ["-C", dir]), "config", "--get", key], { env, timeout: 10_000 }, (error, stdout) => done(error ? null : stdout.trim() || null));
  });

/**
 * The real path of `path`, also when its tail does not exist yet: the nearest existing parent is resolved
 * and the missing parts are appended, so a symlink in any existing parent is followed.
 */
function real(path: string): string {
  const missing: string[] = [];
  for (let dir = path; ; dir = dirname(dir)) {
    try {
      return join(realpathSync(dir), ...missing);
    } catch {
      if (dirname(dir) === dir) return resolve(path);
      missing.unshift(basename(dir));
    }
  }
}

function writable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const inside = (path: string, parent: string): boolean => {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Whether absolute `dir` is, by real path, neither one of `protectedDirs` (registered Projects, worktree roots) nor inside one. */
function outsideProjects(protectedDirs: readonly string[], dir: string): boolean {
  if (!isAbsolute(dir)) return false;
  const path = real(dir);
  return !protectedDirs.some((protectedDir) => inside(path, real(protectedDir)));
}

const protectedDirs = (input: CloneRootInput): string[] => [...input.projectPaths, ...(input.exclude ?? [])];

async function ensureWritable(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    return false;
  }
  return writable(dir);
}

async function homeCandidates(input: CloneRootInput): Promise<string[]> {
  const skip = new Set([input.dataDir, ...(input.exclude ?? [])].map(real));
  const projects = new Set(input.projectPaths.map(real));
  const counted: { dir: string; clones: number }[] = [];
  for (const entry of await readdir(input.home, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(input.home, entry.name);
    if (skip.has(real(dir)) || !outsideProjects(protectedDirs(input), dir)) continue;
    const children = await readdir(dir, { withFileTypes: true }).catch(() => []);
    // A worktree's .git is a file; only a clone owns a .git directory.
    const isClone = (name: string): boolean => {
      try {
        return statSync(join(dir, name, ".git")).isDirectory();
      } catch {
        return false;
      }
    };
    const clones = children.filter((child) => child.isDirectory() && !child.name.startsWith(".") && isClone(child.name) && !projects.has(real(join(dir, child.name)))).length;
    if (clones >= MIN_CLONES) counted.push({ dir, clones });
  }
  return counted.sort((a, b) => b.clones - a.clones || a.dir.localeCompare(b.dir)).map((candidate) => candidate.dir);
}

/**
 * The folder outside every Project where Workers clone external repositories:
 * git `ghq.root`, else the home folder with the most clones, else a folder under the data directory.
 * The choice is remembered and only searched again once the remembered folder is no longer writable.
 */
export async function resolveCloneRoot(input: CloneRootInput): Promise<string> {
  const file = join(input.dataDir, REMEMBERED_FILE);
  try {
    const remembered = (JSON.parse(readFileSync(file, "utf8")) as { path?: unknown }).path;
    if (typeof remembered === "string" && outsideProjects(protectedDirs(input), remembered) && writable(remembered)) return remembered;
  } catch {
    // Nothing remembered yet, or unreadable: resolve again.
  }
  const configured = await (input.gitConfig ?? readGitConfig(input.env))("ghq.root");
  const ghqRoot = configured === null ? null : configured === "~" ? input.home : configured.startsWith("~/") ? join(input.home, configured.slice(2)) : configured;
  const candidates = [...(ghqRoot === null ? [] : [ghqRoot]), ...(await homeCandidates(input)), join(input.dataDir, FALLBACK_DIRNAME), ...(input.ownDir === undefined ? [] : [join(input.ownDir, FALLBACK_DIRNAME)])];
  for (const candidate of candidates) {
    if (!outsideProjects(protectedDirs(input), candidate) || !(await ensureWritable(candidate))) continue;
    // Checked again once the folder exists, in case creating it went through a link into a Project.
    if (!outsideProjects(protectedDirs(input), candidate)) continue;
    await mkdir(input.dataDir, { recursive: true });
    await writeFile(file, JSON.stringify({ path: candidate }));
    return candidate;
  }
  throw new Error("No writable clone root was found.");
}

/** `<host>/<owner>/<repo>` of an https, ssh (`git@host:owner/repo.git`) or file:// URL; null if it has no such parts. */
export function cloneRelativePath(url: string): string | null {
  const scp = /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/\/)(.+)$/.exec(url);
  let host: string;
  let path: string;
  if (scp !== null) {
    host = scp[1] as string;
    path = scp[2] as string;
  } else {
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      path = parsed.pathname;
    } catch {
      return null;
    }
  }
  let parts: string[];
  try {
    // Decoded after splitting, so an encoded separator stays inside its part and is refused below.
    parts = path.replace(/\.git\/?$/, "").split("/").filter((part) => part !== "").map((part) => (scp === null ? decodeURIComponent(part) : part));
  } catch {
    return null;
  }
  // A Windows file:// URL (file:///C:/src/repo.git) starts with a drive; keep only its letter.
  if (scp === null && host === "" && /^[A-Za-z]:$/.test(parts[0] ?? "")) parts[0] = (parts[0] as string).slice(0, 1);
  if (parts.length < 2 || parts.some((part) => part === "." || part === ".." || /[/\\:]/.test(part))) return null;
  const repo = parts.pop() as string;
  const owner = parts.join("/");
  // A file:// URL has no host; "local" keeps the three-level layout.
  return join(host === "" ? "local" : host, owner, repo);
}

export type CloneDestination =
  | { readonly path: string; readonly state: "new" | "existing" }
  | { readonly reason: string };

/**
 * Where to clone `url`: reuse a clone with the same origin URL; never touch a different clone or a non-clone folder,
 * nor a path that is, by real path, inside one of `projectPaths`.
 */
export async function planClone(root: string, url: string, projectPaths: readonly string[] = [], env?: NodeJS.ProcessEnv): Promise<CloneDestination> {
  const rel = cloneRelativePath(url);
  if (rel === null) return { reason: `Cannot derive <host>/<owner>/<repo> from ${url}.` };
  const path = join(root, rel);
  if (!inside(path, root)) return { reason: `${url} maps outside ${root}.` };
  if (!outsideProjects(projectPaths, path)) return { reason: `${path} is inside a registered Project.` };
  if (!existsSync(path)) return { path, state: "new" };
  if (existsSync(join(path, ".git")) && (await readGitConfig(env, path)("remote.origin.url")) === url) return { path, state: "existing" };
  return { reason: `${path} already exists and is not a clone of ${url}; it was left as it is.` };
}
