import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Environment variable that marks every process an Owl instance starts for an agent or a tool. */
export const OWL_INSTANCE_ID_ENV = "OWL_INSTANCE_ID";
/** Characters allowed in an instance id and in an agent run id marker. */
export const OWL_MARKER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

const INSTANCE_ID_FILE = "instance-id";
const cache = new Map<string, string>();

/**
 * The persistent id of the Owl instance that owns `dataDir`. It is created on
 * first use and stored in the data directory, so every process of one data
 * directory shares it and different data directories never do.
 */
export function resolveInstanceId(dataDir: string): string {
  const cached = cache.get(dataDir);
  if (cached !== undefined) return cached;
  const file = join(dataDir, INSTANCE_ID_FILE);
  const read = (): string | null => {
    try {
      const value = readFileSync(file, "utf8").trim();
      return OWL_MARKER_PATTERN.test(value) ? value : null;
    } catch {
      return null;
    }
  };
  let id = read();
  if (id === null) {
    const fresh = randomUUID();
    try {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      writeFileSync(file, `${fresh}\n`, { mode: 0o600, flag: "wx" });
      id = fresh;
    } catch {
      // Another process created it first, or the directory is not writable.
      id = read() ?? fresh;
    }
  }
  cache.set(dataDir, id);
  return id;
}
