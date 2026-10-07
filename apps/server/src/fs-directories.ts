import type { Stats } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import { ApiError } from "./errors.js";

export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: { name: string; path: string }[];
  truncated: boolean;
  shortcuts: DirectoryShortcut[];
}

export interface DirectoryShortcut {
  key: string;
  path: string;
  name?: string;
  kind?: "volume" | "cloud";
}

/** Base locations searched for shortcuts; tests replace them with temporary directories. */
export interface ShortcutRoots {
  homeDir: string;
  volumesDir: string;
  rootDir: string;
}

type DirectoryFs = { stat: typeof stat; readdir: typeof readdir };

const MACOS_PERMISSION_HINT = {
  reason: "macos_privacy",
  settings_paths: [
    "システム設定 > プライバシーとセキュリティ > フルディスクアクセス",
    "システム設定 > プライバシーとセキュリティ > ファイルとフォルダ（リムーバブルボリューム／ネットワークボリューム／ファイルプロバイダ）",
  ],
  steps: "Owl を動かしているアプリ（ターミナルや Node）をオンにして、Owl を再起動してください。",
};

function directoryError(error: unknown): ApiError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return new ApiError(404, "not_found", "フォルダが見つかりません。");
  if (code === "EACCES" || code === "EPERM") return new ApiError(403, "forbidden", "このフォルダを開く権限がありません。", { permission_hint: MACOS_PERMISSION_HINT });
  throw error;
}

async function isDirectory(location: DirectoryShortcut): Promise<DirectoryShortcut | null> {
  try { return (await stat(location.path)).isDirectory() ? location : null; }
  catch { return null; }
}

async function subdirectories(dir: string): Promise<string[]> {
  try { return (await readdir(dir)).sort((a, b) => a.localeCompare(b)); }
  catch { return []; }
}

/** Mounted non-startup volumes, cloud-provider folders and iCloud Drive that exist on this host. */
async function externalShortcuts(home: string, volumesDir: string, rootDir: string): Promise<DirectoryShortcut[]> {
  let rootInfo: Stats | undefined, rootReal: string | undefined;
  try { [rootInfo, rootReal] = await Promise.all([stat(rootDir), realpath(rootDir)]); } catch { /* no startup-disk check possible */ }
  const volumes = (await subdirectories(volumesDir)).map(async (name): Promise<DirectoryShortcut | null> => {
    const path = join(volumesDir, name);
    try {
      const [info, real] = await Promise.all([stat(path), realpath(path)]);
      if (!info.isDirectory() || real === rootReal || (rootInfo && info.dev === rootInfo.dev)) return null;
    } catch { return null; }
    return { key: `volume:${name}`, path, name, kind: "volume" };
  });
  const cloudDir = join(home, "Library", "CloudStorage");
  const cloud = (await subdirectories(cloudDir)).map((name) => isDirectory({ key: `cloud:${name}`, path: join(cloudDir, name), name, kind: "cloud" }));
  const icloud = isDirectory({ key: "icloud", path: join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"), name: "iCloud Drive", kind: "cloud" });
  return (await Promise.all([...volumes, ...cloud, icloud])).filter((item): item is DirectoryShortcut => item !== null);
}

export async function listHostDirectories(path: string | undefined, showHidden: boolean, dataDir: string, roots: Partial<ShortcutRoots> = {}, fsOps: DirectoryFs = { stat, readdir }): Promise<DirectoryListing> {
  const home = roots.homeDir ?? homedir();
  const input = path === undefined ? home : path === "~" ? home : path.startsWith(`~${sep}`) ? join(home, path.slice(2)) : path;
  if (!isAbsolute(input) || input.includes("\0") || input.length > 1024) {
    throw new ApiError(422, "validation_error", "フォルダは絶対パスで指定してください。");
  }
  const directory = resolve(input);
  let info;
  try { info = await fsOps.stat(directory); } catch (error) { throw directoryError(error); }
  if (!info.isDirectory()) throw new ApiError(422, "validation_error", "フォルダではありません。");

  let dirents;
  try { dirents = await fsOps.readdir(directory, { withFileTypes: true }); } catch (error) { throw directoryError(error); }
  const candidates = dirents.filter((entry) => (showHidden || !entry.name.startsWith(".")) && (entry.isDirectory() || entry.isSymbolicLink()));
  const entries = (await Promise.all(candidates.map(async (entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) return { name: entry.name, path: entryPath };
    try { return (await stat(entryPath)).isDirectory() ? { name: entry.name, path: entryPath } : null; }
    catch { return null; }
  }))).filter((entry): entry is { name: string; path: string } => entry !== null);
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));

  const locations = [
    { key: "home", path: home },
    { key: "desktop", path: join(home, "Desktop") },
    { key: "documents", path: join(home, "Documents") },
    { key: "downloads", path: join(home, "Downloads") },
    { key: "owl_data", path: resolve(dataDir) },
  ];
  const shortcuts = (await Promise.all(locations.map(isDirectory))).filter((location): location is DirectoryShortcut => location !== null);
  shortcuts.push(...await externalShortcuts(home, roots.volumesDir ?? "/Volumes", roots.rootDir ?? "/"));
  const parent = dirname(directory);
  return { path: directory, parent: parent === directory ? null : parent, entries: entries.slice(0, 1000), truncated: entries.length > 1000, shortcuts };
}
