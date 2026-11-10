/**
 * Config files that a launched agent CLI reads by path (--mcp-config, a Codex role file).
 * They live in one directory per Owl process, so releasing a file never removes one that
 * another Owl process is still handing to its own child.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let processDir: string | null = null;
const holds = new Map<string, number>();

/** This process's own directory under os.tmpdir(); it is removed when the process exits. */
export function processTempDir(): string {
  if (processDir === null) {
    const dir = mkdtempSync(join(tmpdir(), "owl-process-"));
    processDir = dir;
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  }
  return processDir;
}

/**
 * Writes a content-named file in processTempDir() and holds it until releaseTempConfigFiles
 * gets an argv that names it. Launches with the same content share one file.
 */
export function holdTempConfigFile(prefix: string, extension: string, content: string): string {
  const dir = processTempDir();
  const path = join(dir, `${prefix}-${createHash("sha256").update(content).digest("hex").slice(0, 16)}${extension}`);
  const count = holds.get(path) ?? 0;
  // Rewriting a held file would truncate it under a child that may be reading it right now.
  if (count === 0) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, content, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  holds.set(path, count + 1);
  return path;
}

/** Drops one hold for each argv entry that names a held file; a file with no holds left is deleted. */
export function releaseTempConfigFiles(argv: readonly string[]): void {
  for (const arg of argv) {
    for (const [path, count] of holds) {
      if (!arg.includes(path)) continue;
      if (count > 1) {
        holds.set(path, count - 1);
      } else {
        holds.delete(path);
        rmSync(path, { force: true });
      }
    }
  }
}
