import { readFile } from "node:fs/promises";
import { readStdin } from "./stdio-jsonrpc.js";

import { RELAY_STATE_FILE_ENV } from "@owl/shared/token-relay";
import { isRecord } from "@owl/shared/small-helpers";

/**
 * Hook for relay-watched Claude children. It only reads the state file Owl
 * writes from the stream's token counts; it never counts tokens itself, so
 * the handoff decision and the request records use the same numbers.
 */

async function main(): Promise<number> {
  let input: unknown;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return 0;
  }
  if (!isRecord(input)) return 0;
  if (input.hook_event_name === "PreCompact") {
    process.stderr.write("Owl blocks context compaction for this child; hand off with the owl-child-handoff block instead.\n");
    return 2;
  }
  if (input.hook_event_name !== "PostToolUse") return 0;
  const stateFile = process.env[RELAY_STATE_FILE_ENV];
  if (!stateFile) return 0;
  let state: unknown;
  try {
    state = JSON.parse(await readFile(stateFile, "utf8"));
  } catch {
    return 0;
  }
  if (!isRecord(state) || state.phase !== "handoff" || typeof state.message !== "string") return 0;
  process.stdout.write(`${JSON.stringify({ decision: "block", reason: state.message })}\n`);
  return 0;
}

// Any failure lets the child keep working; the stop limit still bounds it.
void main().then((code) => { process.exitCode = code; }, () => { process.exitCode = 0; });
