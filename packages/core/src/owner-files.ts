import { readdir, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";

import { openPinnedFile } from "./advisor-send-file.js";
import { isPathInside } from "./path-inside.js";
import { HumanReadableError } from "./errors.js";
import { isSecretPath } from "./project-overview-note.js";

export interface OwnerFileRoot { readonly key: string; readonly path: string }
export interface OwnerFileEntry { readonly name: string; readonly isDirectory: boolean }
export type OwnerFileOpened =
  | { readonly kind: "file"; readonly name: string; readonly size: number; readonly mtimeMs: number; readonly handle: FileHandle }
  | { readonly kind: "directory"; readonly entries: OwnerFileEntry[] };
export type OwnerFileDenial = "outside" | "symlink_escape" | "traversal" | "secret" | "unknown_root" | "not_regular" | "permission_denied";

export interface OwnerFilesReaderOptions {
  /** Configured folders the Owner may browse; read on every call so a changed setting applies at once. */
  readonly folders: () => ReadonlyArray<{ readonly key: string; readonly dir: string }>;
}

const denied = (reason: OwnerFileDenial): HumanReadableError => new HumanReadableError({
  code: "owner_file_denied",
  message: reason === "permission_denied" ? "This file or folder cannot be read because of its permissions." : "This path is outside the folders the Owner may open.",
  remediation: reason === "permission_denied" ? "Check the permissions of the file or folder." : "Open a file inside the materials or shared folder.",
  details: { reason },
});

/** EACCES/EPERM from stat or readdir mean the Owner may not read it: answer 4xx, not 500. */
const permissionToDenied = (error: unknown): never => {
  throw ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException)?.code ?? "") ? denied("permission_denied") : error;
};

const missing = (): HumanReadableError => new HumanReadableError({
  code: "owner_file_not_found",
  message: "The file or folder was not found.",
  remediation: "Check the path and try again.",
});

/** Realpath of a folder, or null when it is missing or unmounted. */
const realOrNull = (dir: string): Promise<string | null> => realpath(dir).catch(() => null);

/** Read-only access to a few configured folders. Every decision is made on realpath, so a symlink cannot lead out. */
export class OwnerFilesReader {
  public constructor(private readonly options: OwnerFilesReaderOptions) {}

  public async roots(): Promise<OwnerFileRoot[]> {
    const roots: OwnerFileRoot[] = [];
    for (const { key, dir } of this.options.folders()) {
      const real = await realOrNull(dir);
      if (real) roots.push({ key, path: real });
    }
    return roots;
  }

  /** `segments` are already URL-decoded path segments below the root. */
  public async open(key: string, segments: readonly string[]): Promise<OwnerFileOpened> {
    const root = (await this.roots()).find((candidate) => candidate.key === key);
    if (!root) throw denied("unknown_root");
    for (const segment of segments) {
      if (segment === ".." || segment === "." || segment === "" || /[/\\\u0000]/u.test(segment)) throw denied("traversal");
    }
    if (isSecretPath(segments.join("/"))) throw denied("secret");
    const real = await realpath(join(root.path, ...segments)).catch(() => null);
    if (real === null) throw missing();
    if (real !== root.path) {
      if (!isPathInside(root.path, real, false)) throw denied("symlink_escape");
      // A link to a secret inside the folder is as bad as the secret's own name.
      if (isSecretPath(real.slice(root.path.length + 1))) throw denied("secret");
    }
    const details = await stat(real).catch(permissionToDenied);
    if (details.isDirectory()) return { kind: "directory", entries: await this.list(root.path, real) };
    if (!details.isFile()) throw denied("not_regular");
    const pinned = await openPinnedFile(real);
    if (!pinned.ok) throw pinned.rejection === "not_found" ? missing() : denied("symlink_escape");
    const size = (await pinned.handle.stat()).size;
    return { kind: "file", name: basename(real), size, mtimeMs: details.mtimeMs, handle: pinned.handle };
  }

  private async list(rootReal: string, dir: string): Promise<OwnerFileEntry[]> {
    const entries: OwnerFileEntry[] = [];
    for (const dirent of await readdir(dir, { withFileTypes: true }).catch(permissionToDenied)) {
      if (isSecretPath(dirent.name)) continue;
      const real = await realOrNull(join(dir, dirent.name));
      // Links that lead out of the folder, or broken links, are not offered.
      if (real === null || (real !== rootReal && !isPathInside(rootReal, real, false))) continue;
      const details = await stat(real).catch(() => null);
      if (details && (details.isDirectory() || details.isFile())) entries.push({ name: dirent.name, isDirectory: details.isDirectory() });
    }
    return entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
  }
}
