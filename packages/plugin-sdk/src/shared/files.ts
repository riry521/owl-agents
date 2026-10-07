import { access, lstat, realpath } from "node:fs/promises";
import { join, extname, basename } from "node:path";

export const KNOWN_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp",
  ".txt", ".md", ".csv", ".json", ".yaml", ".yml",
  ".js", ".ts", ".py", ".go", ".rs", ".java", ".rb", ".sh",
  ".pdf", ".zip",
]);

export const EXECUTABLE_EXTENSIONS = new Set([".exe", ".sh", ".bat", ".cmd", ".com", ".msi"]);

export interface DownloadResult {
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly mime: string;
  readonly executable: boolean;
  readonly knownFormat: boolean;
}

export async function uniqueName(dir: string, name: string): Promise<string> {
  const safeInput = basename(name).replace(/[\u0000-\u001f\u007f]/gu, "_");
  const ext = extname(safeInput).replace(/[\\/]/gu, "");
  const base = basename(safeInput, ext).replace(/[^A-Za-z0-9._-]/gu, "_").replace(/^\.+/u, "_") || "file";
  const normalizedDir = await realpath(dir);
  let candidate = `${base}${ext}`;
  let counter = 1;
  while (true) {
    const candidatePath = join(normalizedDir, candidate);
    if (!candidatePath.startsWith(`${normalizedDir}/`)) throw new Error("Upload path escaped its directory.");
    try {
      const existing = await lstat(candidatePath);
      if (existing.isSymbolicLink()) {
        candidate = `${base}_${counter}${ext}`;
        counter += 1;
        continue;
      }
      candidate = `${base}_${counter}${ext}`;
      counter += 1;
    } catch {
      return candidate;
    }
  }
}
