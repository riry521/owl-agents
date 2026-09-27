import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import { ApiError } from "./errors.js";

export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: { name: string; path: string }[];
  truncated: boolean;
  shortcuts: { key: string; path: string }[];
}

function directoryError(error: unknown): ApiError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return new ApiError(404, "not_found", "フォルダが見つかりません。");
  if (code === "EACCES" || code === "EPERM") return new ApiError(403, "forbidden", "このフォルダを開く権限がありません。");
  throw error;
}

export async function listHostDirectories(path: string | undefined, showHidden: boolean, dataDir: string): Promise<DirectoryListing> {
  const home = homedir();
  const input = path === undefined ? home : path === "~" ? home : path.startsWith(`~${sep}`) ? join(home, path.slice(2)) : path;
  if (!isAbsolute(input) || input.includes("\0") || input.length > 1024) {
    throw new ApiError(422, "validation_error", "フォルダは絶対パスで指定してください。");
  }
  const directory = resolve(input);
  let info;
  try { info = await stat(directory); } catch (error) { throw directoryError(error); }
  if (!info.isDirectory()) throw new ApiError(422, "validation_error", "フォルダではありません。");

  let dirents;
  try { dirents = await readdir(directory, { withFileTypes: true }); } catch (error) { throw directoryError(error); }
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
  const shortcuts = (await Promise.all(locations.map(async (location) => {
    try { return (await stat(location.path)).isDirectory() ? location : null; }
    catch { return null; }
  }))).filter((location): location is { key: string; path: string } => location !== null);
  const parent = dirname(directory);
  return { path: directory, parent: parent === directory ? null : parent, entries: entries.slice(0, 1000), truncated: entries.length > 1000, shortcuts };
}
