// Reads the compaction summary a provider wrote to its own transcript file.
// Neither provider puts the summary on its live stream: Claude writes a user
// record flagged isCompactSummary, Codex a `compacted` record whose
// payload.message is the summary.
import { createReadStream, existsSync, readdirSync, type Dirent } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

export interface CompactionSummaries {
  readonly path: string;
  /** One entry per compaction in the transcript, oldest first; "" when the provider kept no text. */
  readonly summaries: readonly string[];
}

async function* jsonLines(path: string): AsyncGenerator<Record<string, unknown>> {
  const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object") yield parsed as Record<string, unknown>;
    } catch {
      // A line still being written is picked up by the next read.
    }
  }
}

function claudeMessageText(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : ""))
    .join("");
}

/** Claude keeps `<configDir>/projects/<cwd with non-alphanumerics as "-">/<sessionId>.jsonl`. */
export async function readClaudeCompactionSummaries(
  configDir: string,
  cwd: string,
  sessionId: string,
): Promise<CompactionSummaries | null> {
  const path = join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/gu, "-"), `${sessionId}.jsonl`);
  if (!existsSync(path)) return null;
  const summaries: string[] = [];
  for await (const record of jsonLines(path)) {
    if (record.type === "user" && record.isCompactSummary === true) summaries.push(claudeMessageText(record.message));
  }
  return { path, summaries };
}

function findCodexRollout(dir: string, threadId: string): string | null {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  entries.sort((a, b) => (a.name < b.name ? 1 : -1));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findCodexRollout(full, threadId);
      if (found) return found;
    } else if (entry.name.startsWith("rollout-") && entry.name.endsWith(`-${threadId}.jsonl`)) {
      return full;
    }
  }
  return null;
}

/** Codex keeps `<codexHome>/sessions/YYYY/MM/DD/rollout-<time>-<threadId>.jsonl`. */
export async function readCodexCompactionSummaries(codexHome: string, threadId: string): Promise<CompactionSummaries | null> {
  const path = findCodexRollout(join(codexHome, "sessions"), threadId);
  if (!path) return null;
  const summaries: string[] = [];
  for await (const record of jsonLines(path)) {
    if (record.type !== "compacted") continue;
    const message = (record.payload as { message?: unknown } | null)?.message;
    summaries.push(typeof message === "string" ? message : "");
  }
  return { path, summaries };
}

/**
 * The summary of the `index`th (1-based) compaction. The transcript can lag the
 * live event, so a missing entry is retried before giving up with null.
 */
export async function waitForCompactionSummary(
  read: () => Promise<CompactionSummaries | null>,
  index: number,
  attempts = 10,
  delayMs = 300,
): Promise<{ summary: string | null; path: string | null }> {
  let path: string | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let found: CompactionSummaries | null = null;
    try {
      found = await read();
    } catch (error) {
      console.warn(`[compaction-summary] Could not read the transcript: ${error instanceof Error ? error.message : String(error)}`);
    }
    path = found?.path ?? path;
    const summary = found?.summaries[index - 1];
    if (summary !== undefined) return { summary: summary.trim().length > 0 ? summary : null, path };
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { summary: null, path };
}
