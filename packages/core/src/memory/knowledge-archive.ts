import { createHash, randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DEFAULT_MEMORY_ARCHIVE_SUFFIX, PAGES_LAYOUT, type MemoryArchive } from "@owl/shared";

const MARKER_FILE = ".owl-knowledge";
const MANIFEST_FILE = "manifest.json";
const FILES_DIR = "files";

interface ManifestEntry { readonly path: string; readonly sha256: string; readonly size: number }
export interface ArchiveManifest {
  readonly version: 1;
  readonly status: "in_progress" | "complete";
  readonly archived_at: string;
  readonly source: string;
  /** The vault marker as it was, byte for byte; null when there was none. */
  readonly marker: string | null;
  readonly dirs: readonly string[];
  readonly files: readonly ManifestEntry[];
}

export interface ArchiveOptions {
  readonly root: string;
  readonly archive: MemoryArchive;
  readonly now?: () => Date;
  /** Injectable so tests can fail a move midway or force the cross-volume path. */
  readonly rename?: typeof rename;
}
export interface ArchiveResult { readonly archived: number; readonly run_dir: string | null }
export interface RestoreResult { readonly restored: number; readonly run_dir: string }

export class ArchiveConflictError extends Error {
  constructor(public readonly conflicts: readonly string[]) {
    super(`保管庫に同じパスのものがあるため戻せません: ${conflicts.slice(0, 5).join(", ")}${conflicts.length > 5 ? " ほか" : ""}`);
  }
}

export function archiveDirFor(root: string, archive: MemoryArchive): string {
  return archive.dir === "" ? `${resolve(root)}${DEFAULT_MEMORY_ARCHIVE_SUFFIX}` : resolve(archive.dir);
}

const sha256 = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
const exists = (path: string) => lstat(path).then(() => true, () => false);
const isCode = (error: unknown, code: string) => (error as { code?: unknown } | null)?.code === code;

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readMarker(root: string): Promise<{ raw: string | null; json: Record<string, unknown> }> {
  const raw = await readFile(join(root, MARKER_FILE), "utf8").catch((error: unknown) => {
    if (isEnoent(error)) return null;
    throw error;
  });
  let json: Record<string, unknown> = {};
  try { const parsed: unknown = raw === null ? {} : JSON.parse(raw); if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) json = parsed as Record<string, unknown>; } catch { /* unreadable marker: treated as legacy */ }
  return { raw, json };
}

/** Moves src to dst; across volumes it copies, verifies the hash, then removes src, so one copy always exists. */
async function moveFile(src: string, dst: string, sha: string, mv: typeof rename): Promise<void> {
  await mkdir(dirname(dst), { recursive: true });
  try {
    await mv(src, dst);
  } catch (error) {
    if (!isCode(error, "EXDEV")) throw error;
    const part = `${dst}.${randomBytes(4).toString("hex")}.part`;
    await copyFile(src, part);
    if (await sha256(part) !== sha) { await unlink(part).catch(() => undefined); throw new Error(`コピーの検証に失敗しました: ${src}`); }
    await rename(part, dst);
    await unlink(src);
  }
}

async function walk(root: string, skipTop: ReadonlySet<string>): Promise<{ dirs: string[]; files: ManifestEntry[] }> {
  const dirs: string[] = [];
  const files: ManifestEntry[] = [];
  const visit = async (rel: string): Promise<void> => {
    for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (rel === "" && skipTop.has(entry.name)) continue;
      if (entry.isDirectory()) { dirs.push(path); await visit(path); }
      else if (entry.isFile()) {
        const full = join(root, path);
        files.push({ path, sha256: await sha256(full), size: (await lstat(full)).size });
      } else throw new Error(`退避できない種類のエントリーがあります（通常のファイルとフォルダーのみ対応）: ${path}`);
    }
  };
  await visit("");
  return { dirs, files };
}

async function readManifest(runDir: string): Promise<ArchiveManifest | null> {
  try { return JSON.parse(await readFile(join(runDir, MANIFEST_FILE), "utf8")) as ArchiveManifest; } catch (error) {
    if (!isEnoent(error)) console.warn(`[owl-core] Could not read the archive manifest in ${runDir}`, error);
    return null;
  }
}

async function listRuns(archiveDir: string): Promise<string[]> {
  return (await readdir(archiveDir).catch(() => [] as string[])).sort().map((name) => join(archiveDir, name));
}

/** Moves every legacy vault entry into the archive and marks the vault as pages. Does nothing once the marker says pages. */
export async function archiveLegacyKnowledge(options: ArchiveOptions): Promise<ArchiveResult> {
  const root = resolve(options.root);
  const mv = options.rename ?? rename;
  const marker = await readMarker(root);
  if (marker.json.layout === PAGES_LAYOUT) return { archived: 0, run_dir: null };

  const archiveDir = archiveDirFor(root, options.archive);
  const inside = relative(root, archiveDir);
  const skip = new Set([MARKER_FILE, ...options.archive.exclude]);
  if (inside !== "" && !inside.startsWith("..") && !isAbsolute(inside)) {
    const top = inside.split(sep)[0]!;
    if (!top.startsWith(".")) throw new Error(`退避先を保管庫の中に置くときは、先頭が "." のフォルダーにしてください: ${archiveDir}`);
    skip.add(top);
  } else if (inside === "") throw new Error("退避先が保管庫そのものです");

  let runDir: string | null = null;
  let manifest: ArchiveManifest | null = null;
  for (const run of (await listRuns(archiveDir)).reverse()) {
    const found = await readManifest(run);
    if (found?.status === "in_progress" && found.source === root) { runDir = run; manifest = found; break; }
  }
  if (!manifest) {
    const { dirs, files } = await walk(root, skip);
    if (files.length > 0 || dirs.length > 0) {
      runDir = join(archiveDir, (options.now?.() ?? new Date()).toISOString().replace(/[:.]/gu, "-"));
      manifest = { version: 1, status: "in_progress", archived_at: (options.now?.() ?? new Date()).toISOString(), source: root, marker: marker.raw, dirs, files };
      await mkdir(join(runDir, FILES_DIR), { recursive: true });
      await writeAtomic(join(runDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    }
  }

  let archived = 0;
  if (manifest && runDir) {
    for (const entry of manifest.files) {
      const src = join(root, entry.path);
      const dst = join(runDir, FILES_DIR, entry.path);
      const srcThere = await exists(src);
      if (await exists(dst)) {
        // An earlier run was interrupted between copying and removing the source.
        if (await sha256(dst) !== entry.sha256) throw new Error(`退避先のファイルが一覧と一致しません: ${entry.path}`);
        if (srcThere && await sha256(src) === entry.sha256) await unlink(src);
        archived += 1;
        continue;
      }
      if (!srcThere) continue;
      await moveFile(src, dst, entry.sha256, mv);
      archived += 1;
    }
    for (const dir of [...manifest.dirs].reverse()) {
      await mkdir(join(runDir, FILES_DIR, dir), { recursive: true });
      await rmdir(join(root, dir)).catch(() => undefined); // not empty: something new or excluded lives there
    }
  }

  await writeAtomic(join(root, MARKER_FILE), `${JSON.stringify({ ...marker.json, layout: PAGES_LAYOUT })}\n`);
  if (manifest && runDir) await writeAtomic(join(runDir, MANIFEST_FILE), `${JSON.stringify({ ...manifest, status: "complete" }, null, 2)}\n`);
  return { archived, run_dir: runDir };
}

/** Copies an archive run back into the vault. Stops without changing anything when a path is already taken. The archive is kept. */
export async function restoreArchivedKnowledge(options: { root: string; archive: MemoryArchive; run?: string }): Promise<RestoreResult> {
  const root = resolve(options.root);
  const archiveDir = archiveDirFor(root, options.archive);
  let runDir: string | null = null;
  let manifest: ArchiveManifest | null = null;
  const runs = options.run ? [join(archiveDir, options.run)] : (await listRuns(archiveDir)).reverse();
  for (const run of runs) {
    const found = await readManifest(run);
    if (found && found.source === root) { runDir = run; manifest = found; break; }
  }
  if (!manifest || !runDir) throw new Error(`この保管庫の退避が見つかりません: ${archiveDir}`);

  const conflicts: string[] = [];
  const isDir = async (path: string) => (await lstat(path).catch(() => null))?.isDirectory() ?? false;
  for (const entry of manifest.files) if (await exists(join(root, entry.path))) conflicts.push(entry.path);
  // Every directory to create (and every parent of a file) must be absent or a real directory, or mkdir would fail after part of the vault was written.
  const wanted = new Set<string>(manifest.dirs);
  for (const entry of manifest.files) wanted.add(dirname(entry.path));
  for (const path of wanted) {
    if (path === ".") continue;
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i += 1) {
      const prefix = parts.slice(0, i).join("/");
      if (await exists(join(root, prefix)) && !(await isDir(join(root, prefix)))) { conflicts.push(prefix); break; }
    }
  }
  if (conflicts.length > 0) throw new ArchiveConflictError([...new Set(conflicts)]);
  for (const entry of manifest.files) {
    if (!(await exists(join(runDir, FILES_DIR, entry.path)))) throw new Error(`退避先にファイルがありません: ${entry.path}`);
  }

  for (const dir of manifest.dirs) await mkdir(join(root, dir), { recursive: true });
  for (const entry of manifest.files) {
    const dst = join(root, entry.path);
    const part = `${dst}.${randomBytes(4).toString("hex")}.part`;
    await copyFile(join(runDir, FILES_DIR, entry.path), part);
    if (await sha256(part) !== entry.sha256) { await unlink(part).catch(() => undefined); throw new Error(`コピーの検証に失敗しました: ${entry.path}`); }
    await rename(part, dst);
  }
  if (manifest.marker === null) await unlink(join(root, MARKER_FILE)).catch((error: unknown) => {
    if (!isEnoent(error)) throw error;
  });
  else await writeAtomic(join(root, MARKER_FILE), manifest.marker);
  return { restored: manifest.files.length, run_dir: runDir };
}
