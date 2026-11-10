import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Defaults are the public writeAtomic's: parent directory created, mode 0o600, exclusive create, temp file removed on failure. */
export interface WriteAtomicOptions {
  /** Create the parent directory first. Callers that own the directory turn it off so a wrong path still fails. */
  readonly mkdir?: boolean;
  /** File mode of the new file; null keeps the process default. */
  readonly mode?: number | null;
  /** Fail instead of overwriting when the temporary path already exists (flag "wx"). */
  readonly exclusive?: boolean;
  /** Remove the temporary file when writing or renaming fails. */
  readonly cleanup?: boolean;
}

/** Atomically replace a file using a sibling temporary file and rename, so a reader never sees half a file. */
export async function writeAtomic(path: string, content: string, options: WriteAtomicOptions = {}): Promise<void> {
  const { mkdir: makeDir = true, mode = 0o600, exclusive = true, cleanup = true } = options;
  if (makeDir) await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", ...(exclusive ? { flag: "wx" } : {}), ...(mode === null ? {} : { mode }) });
    await rename(temporaryPath, path);
  } catch (error) {
    if (cleanup) {
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
      }
    }
    throw error;
  }
}

/** A page or manifest in a directory the caller already owns: no mkdir, process-default mode, no cleanup. */
export const OWNED_DIR_WRITE: WriteAtomicOptions = { mkdir: false, mode: null, cleanup: false };
